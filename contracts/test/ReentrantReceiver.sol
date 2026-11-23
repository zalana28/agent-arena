// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Test-only malicious badge recipient. NEVER deploy to mainnet.
///         Used by test/arena.test.js to prove the ChampionBadge mint
///         cannot be reentered (audit H-1 follow-up): it owns an Agent ID,
///         plays a cell through `play()`, and if its `onERC721Received`
///         hook is ever called during the badge mint it tries to reenter
///         `settleEpoch()` from inside the callback. With the `_mint`
///         fix the hook is never invoked at all, so `callbackCalled`
///         stays false and settlement succeeds with state intact.
interface IArenaMinimal {
    function claimCell(uint8 x, uint8 y, uint256 agentId) external;
    function settleEpoch() external;
}

contract ReentrantReceiver is IERC721Receiver {
    address public immutable arena;
    bool public callbackCalled;
    bool public reenterSucceeded;

    constructor(address _arena) {
        arena = _arena;
    }

    /// @notice Claim a cell as this contract (msg.sender == this contract,
    ///         which must own `agentId`).
    function play(uint8 x, uint8 y, uint256 agentId) external {
        IArenaMinimal(arena).claimCell(x, y, agentId);
    }

    function onERC721Received(
        address operator,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        // Only count callbacks that come from the Arena (i.e. the badge
        // mint): the mock Agent ID mint also calls this hook, with the
        // deployer as operator, and that must not trip the flag.
        if (operator == arena) {
            callbackCalled = true;
            // Try to reenter settlement from inside the mint callback.
            // (With the _mint fix this hook is never called, so this code
            // never runs — that is exactly what the test asserts.)
            try IArenaMinimal(arena).settleEpoch() {
                reenterSucceeded = true;
            } catch {}
        }
        return this.onERC721Received.selector;
    }
}
