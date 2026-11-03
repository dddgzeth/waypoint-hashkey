// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Holds no funds. An owner registers a protective trading rule (stop-loss / take-profit) and later
/// records each execution the agent carried out for it, so the rule and its fills are verifiable on HashKey Chain.
contract WaypointStrategyLog {
    struct Strategy {
        address owner;
        address token;
        address quoteToken;
        uint256 stopLossPrice;   // quote-token base units per 1 whole token; 0 means unset
        uint256 takeProfitPrice; // same unit; 0 means unset
        uint16 sellBps;          // share of the holding sold when a bound is hit, in basis points
        bool active;
    }

    Strategy[] private strategies;

    event StrategyRegistered(uint256 indexed id, address indexed owner, address token, address quoteToken, uint256 stopLossPrice, uint256 takeProfitPrice, uint16 sellBps);
    event StrategyStopped(uint256 indexed id);
    event ExecutionRecorded(uint256 indexed id, address indexed owner, bool takeProfit, uint256 amountIn, uint256 amountOut, bytes32 txHash);

    error NotOwner();
    error BadParams();

    function registerStrategy(address token, address quoteToken, uint256 stopLossPrice, uint256 takeProfitPrice, uint16 sellBps) external returns (uint256 id) {
        if (stopLossPrice == 0 && takeProfitPrice == 0) revert BadParams();
        if (stopLossPrice != 0 && takeProfitPrice != 0 && stopLossPrice >= takeProfitPrice) revert BadParams();
        if (sellBps == 0 || sellBps > 10_000) revert BadParams();
        id = strategies.length;
        strategies.push(Strategy(msg.sender, token, quoteToken, stopLossPrice, takeProfitPrice, sellBps, true));
        emit StrategyRegistered(id, msg.sender, token, quoteToken, stopLossPrice, takeProfitPrice, sellBps);
    }

    function recordExecution(uint256 id, bool takeProfit, uint256 amountIn, uint256 amountOut, bytes32 txHash) external {
        if (strategies[id].owner != msg.sender) revert NotOwner();
        emit ExecutionRecorded(id, msg.sender, takeProfit, amountIn, amountOut, txHash);
    }

    function stopStrategy(uint256 id) external {
        if (strategies[id].owner != msg.sender) revert NotOwner();
        strategies[id].active = false;
        emit StrategyStopped(id);
    }

    function getStrategy(uint256 id) external view returns (Strategy memory) {
        return strategies[id];
    }

    function strategyCount() external view returns (uint256) {
        return strategies.length;
    }
}
