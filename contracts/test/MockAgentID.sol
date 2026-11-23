// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Minimal mock Agent ID for tests only. NEVER deploy to mainnet.
///         The real Agent ID contract (0x60b9262456de011f7d15a54cdd8c48baaa8b022f)
///         has no public mint; this mock lets tests mint Agent IDs to anyone.
contract MockAgentID is ERC721 {
    uint256 public nextTokenId = 1;

    constructor() ERC721("Agent ID", "AI") {}

    function mint(address to) external returns (uint256) {
        uint256 tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        return tokenId;
    }
}
