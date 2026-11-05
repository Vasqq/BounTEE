// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A pot of native tokens with a bug only a deep reentrancy reaches: `dig` re-enters itself
/// `depth` times, and the innermost call does some work and then pays out everything. Each
/// level ignores a failed inner call, so with too little gas (each call keeps 1/64 back) the
/// transaction succeeds and takes nothing.
contract Pot {
    function dig(uint256 depth, address payable to) external {
        if (depth == 0) {
            bytes32 x;
            for (uint256 i; i < 3000; i++) x = keccak256(abi.encode(x, i));
            if (x != bytes32(0)) to.transfer(address(this).balance);
        } else {
            (bool ok,) = address(this).call(abi.encodeCall(this.dig, (depth - 1, to)));
            ok;
        }
    }

    receive() external payable {}
}
