// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ChampionBadge.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AGENT ARENA - on-chain territory grid for Agent ID holders
/// @notice 16x16 grid on BNB Chain. Each Agent ID claims one free cell per
///         epoch, raids adjacent cells, and reinforces its own cells.
///         Epochs last 3 days; the grid resets each epoch and the epoch
///         winner (most cells) receives a soulbound Champion Badge.
/// @dev    NO real-money stakes, NO pot, NO prizes in BNB.
///         Points (cells) and badges only. Every gameplay action costs
///         only the user's own BSC gas (~$0.01-0.03 per move).
/// @dev    Agent ID is verified on-chain via ownerOf(tokenId) on the
///         Agent ID contract (0x60b9262456de011f7d15a54cdd8c48baaa8b022f).
///         The tokenId is passed as an argument because the Agent ID
///         contract does NOT implement tokenOfOwnerByIndex (verified
///         on-chain 2026-11-18).
/// @dev    Ownership uses OpenZeppelin Ownable2Step (audit L-5): the
///         deployer is the initial owner; transferring ownership takes
///         two steps (transferOwnership + acceptOwnership by the new
///         owner) so a mistyped address cannot lock the pause key.
///         The owner's only power is setPaused; see README.
interface IAgentID {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract Arena is Ownable2Step {
    // ------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------
    uint8 public constant GRID_SIZE = 16;
    uint8 public constant MAX_HP = 3;
    uint256 public constant EPOCH_DURATION = 3 days;
    uint256 public constant COOLDOWN = 5 minutes;

    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------
    struct Cell {
        uint256 ownerAgentId; // 0 = unclaimed
        uint8 hp; // 0-3
        uint256 lastActionAt; // cooldown timestamp (raid + reinforce share it)
    }

    // ------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------
    address public immutable agentIdContract;
    ChampionBadge public immutable badge;

    bool public paused;

    uint256 public currentEpoch;
    mapping(uint256 => uint256) public epochStart;
    mapping(uint256 => uint256) public epochEnd;
    mapping(uint256 => bool) public epochSettled;
    mapping(uint256 => uint256) public epochWinnerAgentId;

    // epoch => x => y => Cell
    mapping(uint256 => mapping(uint8 => mapping(uint8 => Cell))) public cells;
    // epoch => agentId => has used the one free claim this epoch
    mapping(uint256 => mapping(uint256 => bool)) public hasClaimed;
    // epoch => agentId => number of cells owned
    mapping(uint256 => mapping(uint256 => uint256)) public cellsOwned;
    // epoch => list of agentIds that have interacted (for winner scan)
    mapping(uint256 => uint256[]) public epochParticipants;
    mapping(uint256 => mapping(uint256 => bool)) public isParticipant;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------
    event CellClaimed(
        uint256 indexed epoch,
        uint8 indexed x,
        uint8 indexed y,
        uint256 agentId,
        address owner
    );
    event CellRaided(
        uint256 indexed epoch,
        uint8 indexed x,
        uint8 indexed y,
        uint256 attackerAgentId,
        uint256 defenderAgentId,
        uint8 damage,
        bool crit,
        uint8 newHp,
        uint256 newOwnerAgentId
    );
    event CellReinforced(
        uint256 indexed epoch,
        uint8 indexed x,
        uint8 indexed y,
        uint256 agentId,
        uint8 newHp
    );
    event EpochSettled(
        uint256 indexed epoch,
        uint256 winnerAgentId,
        address winnerOwner
    );
    event EpochStarted(uint256 indexed epoch, uint256 start, uint256 end);
    event Paused(address indexed by, bool paused);

    // ------------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------------
    modifier whenNotPaused() {
        require(!paused, "Arena: paused");
        _;
    }

    modifier epochActive() {
        require(
            block.timestamp < epochEnd[currentEpoch],
            "Arena: epoch ended, call settleEpoch"
        );
        _;
    }

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------
    /// @param _agentIdContract Agent ID contract address. Pass
    ///        0x60b9262456de011f7d15a54cdd8c48baaa8b022f on BNB Chain mainnet.
    ///        A different address is only useful for testing.
    constructor(address _agentIdContract) Ownable(msg.sender) {
        require(_agentIdContract != address(0), "Arena: bad Agent ID addr");
        agentIdContract = _agentIdContract;
        badge = new ChampionBadge(address(this));
        epochStart[0] = block.timestamp;
        epochEnd[0] = block.timestamp + EPOCH_DURATION;
        emit EpochStarted(0, epochStart[0], epochEnd[0]);
    }

    // ------------------------------------------------------------------------
    // Admin (emergency only)
    // ------------------------------------------------------------------------
    /// @notice Emergency pause. ONLY owner permission in this contract,
    ///         besides the immutable Agent ID address. Pause blocks
    ///         claim/raid/reinforce; settleEpoch stays callable so epochs
    ///         can always advance.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(msg.sender, _paused);
    }

    // ------------------------------------------------------------------------
    // Gameplay
    // ------------------------------------------------------------------------
    /// @notice Claim one free cell for an Agent ID. One free claim per
    ///         Agent ID per epoch. New cell starts at full HP (3).
    function claimCell(
        uint8 x,
        uint8 y,
        uint256 agentId
    ) external whenNotPaused epochActive {
        require(x < GRID_SIZE && y < GRID_SIZE, "Arena: out of grid");
        require(
            IAgentID(agentIdContract).ownerOf(agentId) == msg.sender,
            "Arena: not Agent ID holder"
        );
        require(!hasClaimed[currentEpoch][agentId], "Arena: already claimed");
        Cell storage cell = cells[currentEpoch][x][y];
        require(cell.ownerAgentId == 0, "Arena: cell taken");

        cell.ownerAgentId = agentId;
        cell.hp = MAX_HP;
        cell.lastActionAt = block.timestamp;
        hasClaimed[currentEpoch][agentId] = true;
        cellsOwned[currentEpoch][agentId] += 1;
        _registerParticipant(agentId);

        emit CellClaimed(currentEpoch, x, y, agentId, msg.sender);
    }

    /// @notice Raid a cell adjacent (Manhattan distance 1) to one of your
    ///         cells. Damage 1, with a 25% crit chance (damage 2) from
    ///         keccak256(attacker, defender, blockhash(block-1)).
    ///         At HP 0 the cell flips to the attacker with HP 1.
    ///         5-minute cooldown per target cell.
    function raid(
        uint8 x,
        uint8 y,
        uint256 agentId
    ) external whenNotPaused epochActive {
        require(x < GRID_SIZE && y < GRID_SIZE, "Arena: out of grid");
        require(
            IAgentID(agentIdContract).ownerOf(agentId) == msg.sender,
            "Arena: not Agent ID holder"
        );
        Cell storage cell = cells[currentEpoch][x][y];
        uint256 defenderAgentId = cell.ownerAgentId;
        require(defenderAgentId != 0, "Arena: cell unclaimed, claim it");
        require(defenderAgentId != agentId, "Arena: own cell, reinforce it");
        require(
            block.timestamp >= cell.lastActionAt + COOLDOWN,
            "Arena: cell on cooldown"
        );
        require(
            _isAdjacentToOwnCell(x, y, agentId),
            "Arena: not adjacent to your cells"
        );

        uint8 damage = _rollDamage(agentId, defenderAgentId);
        bool crit = damage == 2;
        cell.lastActionAt = block.timestamp;

        uint256 newOwner = defenderAgentId;
        if (cell.hp <= damage) {
            // Cell falls: flips to attacker with HP 1 (vulnerable, can be
            // raided straight back - the drama).
            cell.ownerAgentId = agentId;
            cell.hp = 1;
            newOwner = agentId;
            cellsOwned[currentEpoch][agentId] += 1;
            cellsOwned[currentEpoch][defenderAgentId] -= 1;
            _registerParticipant(agentId);
        } else {
            cell.hp -= damage;
        }

        emit CellRaided(
            currentEpoch,
            x,
            y,
            agentId,
            defenderAgentId,
            damage,
            crit,
            cell.hp,
            newOwner
        );
    }

    /// @notice Restore 1 HP to your own cell (max 3).
    ///         5-minute cooldown per cell.
    function reinforce(
        uint8 x,
        uint8 y,
        uint256 agentId
    ) external whenNotPaused epochActive {
        require(x < GRID_SIZE && y < GRID_SIZE, "Arena: out of grid");
        require(
            IAgentID(agentIdContract).ownerOf(agentId) == msg.sender,
            "Arena: not Agent ID holder"
        );
        Cell storage cell = cells[currentEpoch][x][y];
        require(cell.ownerAgentId == agentId, "Arena: not your cell");
        require(cell.hp < MAX_HP, "Arena: already full HP");
        require(
            block.timestamp >= cell.lastActionAt + COOLDOWN,
            "Arena: cell on cooldown"
        );

        cell.hp += 1;
        cell.lastActionAt = block.timestamp;

        emit CellReinforced(currentEpoch, x, y, agentId, cell.hp);
    }

    // ------------------------------------------------------------------------
    // Epochs
    // ------------------------------------------------------------------------
    /// @notice Settle the current epoch once it has ended. Permissionless -
    ///         anyone can call it. The Agent ID with the most cells wins a
    ///         soulbound Champion Badge (minted to the Agent ID owner).
    ///         Ties go to the participant who interacted first. If nobody
    ///         played, no badge is minted. Starts the next epoch.
    function settleEpoch() external {
        uint256 epoch = currentEpoch;
        require(block.timestamp >= epochEnd[epoch], "Arena: epoch not over");
        require(!epochSettled[epoch], "Arena: already settled");

        epochSettled[epoch] = true;

        uint256 winner = 0;
        uint256 best = 0;
        uint256[] storage participants = epochParticipants[epoch];
        for (uint256 i = 0; i < participants.length; i++) {
            uint256 candidate = participants[i];
            uint256 count = cellsOwned[epoch][candidate];
            if (count > best) {
                best = count;
                winner = candidate;
            }
        }

        address winnerOwner = address(0);
        if (winner != 0) {
            epochWinnerAgentId[epoch] = winner;
            winnerOwner = IAgentID(agentIdContract).ownerOf(winner);
            badge.mint(winnerOwner, epoch);
        }

        emit EpochSettled(epoch, winner, winnerOwner);

        currentEpoch = epoch + 1;
        epochStart[currentEpoch] = block.timestamp;
        epochEnd[currentEpoch] = block.timestamp + EPOCH_DURATION;
        emit EpochStarted(
            currentEpoch,
            epochStart[currentEpoch],
            epochEnd[currentEpoch]
        );
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------
    function getCell(
        uint256 epoch,
        uint8 x,
        uint8 y
    )
        external
        view
        returns (uint256 ownerAgentId, uint8 hp, uint256 lastActionAt)
    {
        Cell storage cell = cells[epoch][x][y];
        return (cell.ownerAgentId, cell.hp, cell.lastActionAt);
    }

    /// @notice Cells owned by an Agent ID in an epoch.
    function cellsOwnedOf(
        uint256 epoch,
        uint256 agentId
    ) external view returns (uint256) {
        return cellsOwned[epoch][agentId];
    }

    /// @notice Winner Agent ID of a settled epoch (0 if none / not settled).
    function epochWinner(uint256 epoch) external view returns (uint256) {
        return epochWinnerAgentId[epoch];
    }

    /// @notice (epoch start, epoch end, settled, winner Agent ID).
    function epochInfo(
        uint256 epoch
    )
        external
        view
        returns (
            uint256 start,
            uint256 end,
            bool settled,
            uint256 winnerAgentId
        )
    {
        return (
            epochStart[epoch],
            epochEnd[epoch],
            epochSettled[epoch],
            epochWinnerAgentId[epoch]
        );
    }

    function participantCount(uint256 epoch) external view returns (uint256) {
        return epochParticipants[epoch].length;
    }

    /// @notice Helper for frontends: does `account` own this Agent ID?
    /// @dev The Agent ID contract has no enumeration, so there is no
    ///      on-chain way to list an address's Agent IDs; the frontend
    ///      resolves tokenIds via Transfer events / tokenURI instead.
    function isAgentOwner(
        uint256 agentId,
        address account
    ) external view returns (bool) {
        return IAgentID(agentIdContract).ownerOf(agentId) == account;
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------
    function _registerParticipant(uint256 agentId) internal {
        if (!isParticipant[currentEpoch][agentId]) {
            isParticipant[currentEpoch][agentId] = true;
            epochParticipants[currentEpoch].push(agentId);
        }
    }

    function _isAdjacentToOwnCell(
        uint8 x,
        uint8 y,
        uint256 agentId
    ) internal view returns (bool) {
        if (x > 0 && cells[currentEpoch][x - 1][y].ownerAgentId == agentId)
            return true;
        if (
            x + 1 < GRID_SIZE &&
            cells[currentEpoch][x + 1][y].ownerAgentId == agentId
        ) return true;
        if (y > 0 && cells[currentEpoch][x][y - 1].ownerAgentId == agentId)
            return true;
        if (
            y + 1 < GRID_SIZE &&
            cells[currentEpoch][x][y + 1].ownerAgentId == agentId
        ) return true;
        return false;
    }

    /// @dev 25% crit: hash % 4 == 0. Pure points - blockhash influence
    ///      wins nothing of economic value, so manipulation is pointless.
    function _rollDamage(
        uint256 attackerAgentId,
        uint256 defenderAgentId
    ) internal view returns (uint8) {
        uint256 roll = uint256(
            keccak256(
                abi.encodePacked(
                    attackerAgentId,
                    defenderAgentId,
                    blockhash(block.number - 1)
                )
            )
        ) % 4;
        return roll == 0 ? 2 : 1;
    }
}
