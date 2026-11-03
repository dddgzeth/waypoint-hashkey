/**
 * Reference contracts handed to the contract-authoring stage as starting
 * points ("adapt this" rather than "write from nothing"). They are the
 * patterns every generated contract is expected to follow: an immutable
 * owner, owner-only entry points, a re-entrancy guard, custom errors, events,
 * an escape hatch that returns stray funds to the owner, and — for any
 * strategy that trades — a hard revert when the minimum profit is not met.
 *
 * Add a new reference by exporting another entry in REFERENCE_CONTRACTS; the
 * author stage includes every entry in its prompt.
 */
export interface ReferenceContract {
  name: string;
  description: string;
  source: string;
}

const PROFIT_GUARDED_EXECUTOR = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// Runs an owner-supplied list of external calls in one transaction and reverts the whole
/// transaction unless the contract ends with at least \`minProfit\` more of \`profitToken\`
/// (address(0) = native token) than it started with. The funds never leave the contract
/// except to the owner, so a failed or unprofitable run only costs gas.
contract ProfitGuardedExecutor {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable owner;
    uint256 private _status = 1;

    event Executed(address indexed profitToken, uint256 profit);

    error NotOwner();
    error Reentrant();
    error CallFailed(uint256 index, bytes reason);
    error ProfitTooLow(uint256 got, uint256 want);
    error PayoutFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_status == 2) revert Reentrant();
        _status = 2;
        _;
        _status = 1;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function execute(Call[] calldata calls, address profitToken, uint256 minProfit)
        external
        payable
        onlyOwner
        nonReentrant
        returns (uint256 profit)
    {
        uint256 before = _balance(profitToken) - (profitToken == address(0) ? msg.value : 0);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory reason) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, reason);
        }
        uint256 afterBalance = _balance(profitToken);
        if (afterBalance < before + minProfit) revert ProfitTooLow(afterBalance > before ? afterBalance - before : 0, minProfit);
        profit = afterBalance - before;
        emit Executed(profitToken, profit);
        _payout(profitToken, afterBalance);
    }

    function rescue(address token) external onlyOwner {
        _payout(token, _balance(token));
    }

    function _balance(address token) private view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _payout(address token, uint256 amount) private {
        if (token == address(0)) {
            (bool sent,) = owner.call{value: amount}("");
            if (!sent) revert PayoutFailed();
        } else {
            IERC20(token).transfer(owner, amount);
        }
    }
}
`;

export const REFERENCE_CONTRACTS: ReferenceContract[] = [
  {
    name: "ProfitGuardedExecutor",
    description:
      "An atomic strategy runner: executes a list of calls (swaps on several pools, flash-loan legs, ...) and reverts unless the minimum profit is reached. Use this shape for any trading or arbitrage contract.",
    source: PROFIT_GUARDED_EXECUTOR,
  },
];
