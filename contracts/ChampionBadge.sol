// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title AGENT ARENA Champion Badge - soulbound ERC-721
/// @notice One badge per epoch winner, minted by the Arena contract only.
///         Non-transferable (soulbound): transfers are blocked, only
///         minting (from address(0)) is allowed. No monetary value -
///         a badge of honor, not a prize asset.
contract ChampionBadge is ERC721 {
    using Strings for uint256;

    address public immutable arena;
    uint256 public nextTokenId = 1;

    mapping(uint256 => uint256) public tokenEpoch;

    event BadgeMinted(
        uint256 indexed tokenId,
        address indexed to,
        uint256 indexed epoch
    );

    modifier onlyArena() {
        require(msg.sender == arena, "ChampionBadge: only Arena");
        _;
    }

    constructor(address _arena) ERC721("AGENT ARENA Champion", "ARENACHAMP") {
        require(_arena != address(0), "ChampionBadge: bad arena addr");
        arena = _arena;
    }

    /// @notice Mint a badge to an epoch winner. Arena only.
    /// @dev Uses plain `_mint`, NOT `_safeMint`, on purpose (audit H-1,
    ///      2026-11-23): `_safeMint` calls `onERC721Received` on the
    ///      recipient, so if the winner is a contract wallet without that
    ///      hook, the mint reverts and `settleEpoch` can never succeed —
    ///      the game would brick forever with no recovery path. The
    ///      receiver check buys nothing here: minting is Arena-only, the
    ///      badge is soulbound (it can never move onward), and the
    ///      recipient is the verified Agent ID owner.
    function mint(address to, uint256 epoch) external onlyArena returns (uint256) {
        uint256 tokenId = nextTokenId++;
        tokenEpoch[tokenId] = epoch;
        _mint(to, tokenId);
        emit BadgeMinted(tokenId, to, epoch);
        return tokenId;
    }

    /// @notice Soulbound: block every transfer. Minting (from == 0) is the
    ///         only allowed movement. Burning is not offered.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        require(
            from == address(0),
            "ChampionBadge: soulbound, transfers blocked"
        );
        return super._update(to, tokenId, auth);
    }

    /// @notice On-chain metadata: epoch + title. No external server needed.
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "ChampionBadge: no token");
        uint256 epoch = tokenEpoch[tokenId];
        string memory name = string(
            abi.encodePacked("AGENT ARENA Champion - Epoch ", epoch.toString())
        );
        string memory json = string(
            abi.encodePacked(
                '{"name":"',
                name,
                '","description":"Champion of AGENT ARENA epoch ',
                epoch.toString(),
                '. Most territory held when the epoch ended. Points and badges only - no monetary value.","attributes":[{"trait_type":"Epoch","value":',
                epoch.toString(),
                '},{"trait_type":"Title","value":"Champion"}]}'
            )
        );
        return
            string(
                abi.encodePacked(
                    "data:application/json;base64,",
                    Base64.encode(bytes(json))
                )
            );
    }
}
