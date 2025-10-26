import Transaction from "../../models/Transaction.js";
import Order from "../../models/OrderSchema.js";
import LPPosition from "../../models/LPPositionSchema.js";
import Account from "../../models/AccountSchema.js";
import Ledger from "../../models/LedgerSchema.js";
import mongoose from "mongoose";

/**
 * @desc Main MIS Analytics Overview - Lightweight summary
 * @route GET /api/admin/mis-analytics/:adminId
 */
export const getMISOverview = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { filter = "monthly", year = new Date().getFullYear(), userId } = req.query;

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid adminId" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
    };

    if (userId && mongoose.isValidObjectId(userId)) {
      baseMatch.user = new mongoose.Types.ObjectId(userId);
    }

    // Parallel execution for overview metrics
    const [
      transactionMetrics,
      orderMetrics,
      lpMetrics,
      accountMetrics,
      ledgerCount
    ] = await Promise.all([
      getTransactionMetrics(baseMatch),
      getOrderMetrics(baseMatch),
      getLPMetrics(baseMatch),
      getAccountMetrics(adminId, userId),
      Ledger.countDocuments(baseMatch)
    ]);

    return res.status(200).json({
      success: true,
      message: "MIS overview retrieved successfully",
      data: {
        summary: {
          ...transactionMetrics,
          ...orderMetrics,
          ...lpMetrics,
          ...accountMetrics,
          ledgerCount,
        },
        filter,
        year,
        userId: userId || null,
        dateRange: { start: dateRange.start, end: dateRange.end },
      },
    });
  } catch (error) {
    console.error("Error fetching MIS overview:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch MIS overview",
      error: error.message,
    });
  }
};

/**
 * @desc Get Top Users by Orders Performance
 * @route GET /api/admin/mis-analytics/top-users/:adminId
 */
export const getTopUsersByOrders = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { filter = "monthly", year = new Date().getFullYear(), limit = 10 } = req.query;

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid adminId" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
      orderStatus: "CLOSED"
    };

    const topUsers = await Order.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: "$user",
          totalOrders: { $sum: 1 },
          totalProfit: { $sum: "$profit" },
          totalVolume: { $sum: "$volume" },
          avgOrderSize: { $avg: "$volume" },
          avgProfit: { $avg: "$profit" },
          totalBuyOrders: {
            $sum: { $cond: [{ $eq: ["$type", "BUY"] }, 1, 0] }
          },
          totalSellOrders: {
            $sum: { $cond: [{ $eq: ["$type", "SELL"] }, 1, 0] }
          },
          totalOrderValue: {
            $sum: { $multiply: ["$volume", "$openingPrice"] }
          },
          winningOrders: {
            $sum: { $cond: [{ $gt: ["$profit", 0] }, 1, 0] }
          },
          losingOrders: {
            $sum: { $cond: [{ $lt: ["$profit", 0] }, 1, 0] }
          },
        },
      },
      {
        $lookup: {
          from: "accounts",
          localField: "_id",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      { $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          winRate: {
            $cond: [
              { $gt: ["$totalOrders", 0] },
              { $multiply: [{ $divide: ["$winningOrders", "$totalOrders"] }, 100] },
              0
            ]
          },
          profitFactor: {
            $cond: [
              { $gt: ["$totalProfit", 0] },
              { $divide: ["$totalProfit", { $abs: "$totalProfit" }] },
              0
            ]
          }
        }
      },
      {
        $project: {
          userId: "$_id",
          name: {
            $concat: [
              { $ifNull: ["$userDetails.firstName", ""] },
              " ",
              { $ifNull: ["$userDetails.lastName", ""] }
            ]
          },
          accountHead: "$userDetails.ACCOUNT_HEAD",
          email: "$userDetails.email",
          accountStatus: "$userDetails.accountStatus",
          totalOrders: 1,
          totalProfit: { $round: ["$totalProfit", 2] },
          totalVolume: { $round: ["$totalVolume", 2] },
          avgOrderSize: { $round: ["$avgOrderSize", 2] },
          avgProfit: { $round: ["$avgProfit", 2] },
          totalOrderValue: { $round: ["$totalOrderValue", 2] },
          totalBuyOrders: 1,
          totalSellOrders: 1,
          winningOrders: 1,
          losingOrders: 1,
          winRate: { $round: ["$winRate", 2] },
          profitFactor: { $round: ["$profitFactor", 2] },
        },
      },
      { $sort: { totalProfit: -1 } },
      { $limit: parseInt(limit) },
    ]);

    return res.status(200).json({
      success: true,
      message: "Top users by orders retrieved successfully",
      data: topUsers,
      metadata: {
        filter,
        year,
        limit: parseInt(limit),
        dateRange: { start: dateRange.start, end: dateRange.end },
      },
    });
  } catch (error) {
    console.error("Error fetching top users by orders:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch top users",
      error: error.message,
    });
  }
};

/**
 * @desc Get Symbol-wise Trading Analysis
 * @route GET /api/admin/mis-analytics/symbol-analysis/:adminId
 */
export const getSymbolAnalysis = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { filter = "monthly", year = new Date().getFullYear() } = req.query;

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid adminId" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
      orderStatus: "CLOSED"
    };

    const symbolStats = await Order.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: {
            symbol: "$symbol",
            type: "$type"
          },
          totalOrders: { $sum: 1 },
          totalVolume: { $sum: "$volume" },
          totalProfit: { $sum: "$profit" },
          avgPrice: { $avg: "$openingPrice" },
          minPrice: { $min: "$openingPrice" },
          maxPrice: { $max: "$openingPrice" },
        },
      },
      {
        $group: {
          _id: "$_id.symbol",
          buyOrders: {
            $sum: { $cond: [{ $eq: ["$_id.type", "BUY"] }, "$totalOrders", 0] }
          },
          sellOrders: {
            $sum: { $cond: [{ $eq: ["$_id.type", "SELL"] }, "$totalOrders", 0] }
          },
          totalOrders: { $sum: "$totalOrders" },
          totalVolume: { $sum: "$totalVolume" },
          totalProfit: { $sum: "$totalProfit" },
          avgPrice: { $avg: "$avgPrice" },
          priceRange: {
            min: { $min: "$minPrice" },
            max: { $max: "$maxPrice" }
          },
          details: {
            $push: {
              type: "$_id.type",
              orders: "$totalOrders",
              volume: "$totalVolume",
              profit: "$totalProfit",
            }
          }
        },
      },
      {
        $project: {
          symbol: "$_id",
          buyOrders: 1,
          sellOrders: 1,
          totalOrders: 1,
          totalVolume: { $round: ["$totalVolume", 2] },
          totalProfit: { $round: ["$totalProfit", 2] },
          avgPrice: { $round: ["$avgPrice", 2] },
          priceRange: 1,
          buyVsSellRatio: {
            $cond: [
              { $gt: ["$sellOrders", 0] },
              { $round: [{ $divide: ["$buyOrders", "$sellOrders"] }, 2] },
              "$buyOrders"
            ]
          },
          profitPerOrder: {
            $cond: [
              { $gt: ["$totalOrders", 0] },
              { $round: [{ $divide: ["$totalProfit", "$totalOrders"] }, 2] },
              0
            ]
          },
          details: 1,
        },
      },
      { $sort: { totalProfit: -1 } },
    ]);

    // Get time-series data for top 5 symbols
    const topSymbols = symbolStats.slice(0, 5).map(s => s.symbol);
    const timeSeriesData = await getSymbolTimeSeries(
      adminId,
      topSymbols,
      dateRange,
      filter
    );

    return res.status(200).json({
      success: true,
      message: "Symbol analysis retrieved successfully",
      data: {
        symbolStats,
        topSymbols: symbolStats.slice(0, 10),
        timeSeriesData,
        summary: {
          totalSymbols: symbolStats.length,
          mostProfitable: symbolStats[0] || null,
          mostTraded: symbolStats.sort((a, b) => b.totalOrders - a.totalOrders)[0] || null,
        }
      },
      metadata: {
        filter,
        year,
        dateRange: { start: dateRange.start, end: dateRange.end },
      },
    });
  } catch (error) {
    console.error("Error fetching symbol analysis:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch symbol analysis",
      error: error.message,
    });
  }
};

/**
 * @desc Get Chart Data for Trends
 * @route GET /api/admin/mis-analytics/charts/:adminId
 */
export const getChartData = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { filter = "monthly", year = new Date().getFullYear(), userId } = req.query;

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid adminId" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
    };

    if (userId && mongoose.isValidObjectId(userId)) {
      baseMatch.user = new mongoose.Types.ObjectId(userId);
    }

    const chartData = await generateChartData(adminId, filter, year, dateRange, userId);

    return res.status(200).json({
      success: true,
      message: "Chart data retrieved successfully",
      data: chartData,
      metadata: { filter, year, userId: userId || null },
    });
  } catch (error) {
    console.error("Error fetching chart data:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch chart data",
      error: error.message,
    });
  }
};

/**
 * @desc Get User Activity Breakdown
 * @route GET /api/admin/mis-analytics/user-activity/:adminId/:userId
 */
export const getUserActivity = async (req, res) => {
  try {
    const { adminId, userId } = req.params;
    const { filter = "monthly", year = new Date().getFullYear() } = req.query;

    if (!mongoose.isValidObjectId(adminId) || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: "Invalid IDs" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      user: new mongoose.Types.ObjectId(userId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
    };

    const [userInfo, transactions, orders, lpPositions] = await Promise.all([
      Account.findById(userId).lean(),
      Transaction.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
            totalAmount: { $sum: "$amount" },
            avgAmount: { $avg: "$amount" },
          },
        },
      ]),
      Order.aggregate([
        { $match: { ...baseMatch, orderStatus: "CLOSED" } },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  totalOrders: { $sum: 1 },
                  totalProfit: { $sum: "$profit" },
                  totalVolume: { $sum: "$volume" },
                  avgProfit: { $avg: "$profit" },
                },
              },
            ],
            bySymbol: [
              {
                $group: {
                  _id: "$symbol",
                  orders: { $sum: 1 },
                  profit: { $sum: "$profit" },
                  volume: { $sum: "$volume" },
                },
              },
              { $sort: { profit: -1 } },
            ],
            byType: [
              {
                $group: {
                  _id: "$type",
                  orders: { $sum: 1 },
                  profit: { $sum: "$profit" },
                },
              },
            ],
          },
        },
      ]),
      LPPosition.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            totalProfit: { $sum: "$profit" },
          },
        },
      ]),
    ]);

    return res.status(200).json({
      success: true,
      message: "User activity retrieved successfully",
      data: {
        userInfo: {
          userId: userInfo._id,
          name: `${userInfo.firstName || ""} ${userInfo.lastName || ""}`.trim(),
          accountHead: userInfo.ACCOUNT_HEAD,
          email: userInfo.email,
          balance: userInfo.AMOUNTFC,
          margin: userInfo.margin,
          status: userInfo.accountStatus,
        },
        transactions,
        orders: orders[0] || {},
        lpPositions,
      },
      metadata: { filter, year, dateRange: { start: dateRange.start, end: dateRange.end } },
    });
  } catch (error) {
    console.error("Error fetching user activity:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user activity",
      error: error.message,
    });
  }
};

// ==================== Helper Functions ====================

async function getTransactionMetrics(baseMatch) {
  const [deposits, withdrawals, count] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...baseMatch, type: "DEPOSIT", status: "COMPLETED" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, type: "WITHDRAWAL", status: "COMPLETED" } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Transaction.countDocuments(baseMatch),
  ]);

  return {
    totalTransactions: count,
    totalDeposits: deposits[0]?.total || 0,
    depositCount: deposits[0]?.count || 0,
    totalWithdrawals: withdrawals[0]?.total || 0,
    withdrawalCount: withdrawals[0]?.count || 0,
    netCashFlow: (deposits[0]?.total || 0) - (withdrawals[0]?.total || 0),
  };
}

async function getOrderMetrics(baseMatch) {
  const [openCount, closedCount, profitData] = await Promise.all([
    Order.countDocuments({ ...baseMatch, orderStatus: "OPEN" }),
    Order.countDocuments({ ...baseMatch, orderStatus: "CLOSED" }),
    Order.aggregate([
      { $match: { ...baseMatch, orderStatus: "CLOSED" } },
      {
        $group: {
          _id: null,
          totalProfit: { $sum: "$profit" },
          totalVolume: { $sum: "$volume" },
          avgProfit: { $avg: "$profit" },
          winningOrders: { $sum: { $cond: [{ $gt: ["$profit", 0] }, 1, 0] } },
          losingOrders: { $sum: { $cond: [{ $lt: ["$profit", 0] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const data = profitData[0] || {};
  return {
    openOrders: openCount,
    closedOrders: closedCount,
    totalOrderProfit: data.totalProfit || 0,
    totalOrderVolume: data.totalVolume || 0,
    avgOrderProfit: data.avgProfit || 0,
    winningOrders: data.winningOrders || 0,
    losingOrders: data.losingOrders || 0,
    winRate: closedCount > 0 ? ((data.winningOrders || 0) / closedCount) * 100 : 0,
  };
}

async function getLPMetrics(baseMatch) {
  const [openCount, closedCount, profitData] = await Promise.all([
    LPPosition.countDocuments({ ...baseMatch, status: "OPEN" }),
    LPPosition.countDocuments({ ...baseMatch, status: "CLOSED" }),
    LPPosition.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          totalProfit: { $sum: "$profit" },
          totalVolume: { $sum: "$volume" },
        },
      },
    ]),
  ]);

  return {
    lpOpenPositions: openCount,
    lpClosedPositions: closedCount,
    lpTotalProfit: profitData[0]?.totalProfit || 0,
    lpTotalVolume: profitData[0]?.totalVolume || 0,
  };
}

async function getAccountMetrics(adminId, userId) {
  const query = userId
    ? { _id: new mongoose.Types.ObjectId(userId), addedBy: adminId }
    : { addedBy: adminId };

  const accounts = await Account.find(query).lean();

  const metrics = {
    totalAccounts: accounts.length,
    totalBalance: 0,
    totalGold: 0,
    totalMargin: 0,
    totalReserved: 0,
    activeAccounts: 0,
    inactiveAccounts: 0,
    suspendedAccounts: 0,
    pendingAccounts: 0,
  };

  accounts.forEach(acc => {
    metrics.totalBalance += acc.AMOUNTFC || 0;
    metrics.totalGold += acc.METAL_WT || 0;
    metrics.totalMargin += acc.margin || 0;
    metrics.totalReserved += acc.reservedAmount || 0;
    
    if (acc.accountStatus === "active") metrics.activeAccounts++;
    else if (acc.accountStatus === "inactive") metrics.inactiveAccounts++;
    else if (acc.accountStatus === "suspended") metrics.suspendedAccounts++;
    else if (acc.accountStatus === "pending") metrics.pendingAccounts++;
  });

  return metrics;
}

async function getSymbolTimeSeries(adminId, symbols, dateRange, filter) {
  const groupBy = filter === "daily"
    ? { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } }
    : filter === "monthly"
    ? { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }
    : { year: { $year: "$createdAt" } };

  return await Order.aggregate([
    {
      $match: {
        adminId: new mongoose.Types.ObjectId(adminId),
        symbol: { $in: symbols },
        orderStatus: "CLOSED",
        createdAt: { $gte: dateRange.start, $lte: dateRange.end },
      },
    },
    {
      $group: {
        _id: { ...groupBy, symbol: "$symbol" },
        orders: { $sum: 1 },
        profit: { $sum: "$profit" },
        volume: { $sum: "$volume" },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
  ]);
}

async function generateChartData(adminId, filter, year, dateRange, userId = null) {
  const baseMatch = {
    adminId: new mongoose.Types.ObjectId(adminId),
    createdAt: { $gte: dateRange.start, $lte: dateRange.end },
  };

  if (userId) {
    baseMatch.user = new mongoose.Types.ObjectId(userId);
  }

  let groupBy, periods;
  if (filter === "daily") {
    groupBy = { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } };
    periods = generateDailyPeriods(30);
  } else if (filter === "monthly") {
    groupBy = { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } };
    periods = generateMonthlyPeriods(year);
  } else {
    groupBy = { year: { $year: "$createdAt" } };
    periods = generateYearlyPeriods(year);
  }

  const [transactionTrends, profitTrends, lpTrends] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...baseMatch, status: "COMPLETED" } },
      {
        $group: {
          _id: groupBy,
          deposits: { $sum: { $cond: [{ $eq: ["$type", "DEPOSIT"] }, "$amount", 0] } },
          withdrawals: { $sum: { $cond: [{ $eq: ["$type", "WITHDRAWAL"] }, "$amount", 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]),
    Order.aggregate([
      { $match: { ...baseMatch, orderStatus: "CLOSED" } },
      {
        $group: {
          _id: groupBy,
          profit: { $sum: "$profit" },
          orders: { $sum: 1 },
          volume: { $sum: "$volume" },
          buyOrders: { $sum: { $cond: [{ $eq: ["$type", "BUY"] }, 1, 0] } },
          sellOrders: { $sum: { $cond: [{ $eq: ["$type", "SELL"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]),
    LPPosition.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: groupBy,
          lpProfit: { $sum: "$profit" },
          lpCount: { $sum: 1 },
          lpVolume: { $sum: "$volume" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]),
  ]);

  const trends = periods.map((period) => {
    const trans = transactionTrends.find((t) => matchPeriod(t._id, period, filter));
    const profit = profitTrends.find((t) => matchPeriod(t._id, period, filter));
    const lp = lpTrends.find((t) => matchPeriod(t._id, period, filter));

    return {
      period: period.label,
      deposits: Math.round(trans?.deposits || 0),
      withdrawals: Math.round(trans?.withdrawals || 0),
      profit: Math.round(profit?.profit || 0),
      orders: profit?.orders || 0,
      volume: Math.round(profit?.volume || 0),
      buyOrders: profit?.buyOrders || 0,
      sellOrders: profit?.sellOrders || 0,
      lpProfit: Math.round(lp?.lpProfit || 0),
      lpCount: lp?.lpCount || 0,
      netCashFlow: Math.round((trans?.deposits || 0) - (trans?.withdrawals || 0)),
    };
  });

  const totalOrderProfit = profitTrends.reduce((sum, t) => sum + (t.profit || 0), 0);
  const totalLPProfit = lpTrends.reduce((sum, t) => sum + (t.lpProfit || 0), 0);
  const totalDeposits = transactionTrends.reduce((sum, t) => sum + (t.deposits || 0), 0);
  const totalWithdrawals = transactionTrends.reduce((sum, t) => sum + (t.withdrawals || 0), 0);

  return {
    trends,
    summary: {
      totalOrderProfit: Math.round(totalOrderProfit),
      totalLPProfit: Math.round(totalLPProfit),
      totalProfit: Math.round(totalOrderProfit + totalLPProfit),
      totalDeposits: Math.round(totalDeposits),
      totalWithdrawals: Math.round(totalWithdrawals),
      netCashFlow: Math.round(totalDeposits - totalWithdrawals),
    },
  };
}

function getDateRange(filter, year) {
  const currentYear = parseInt(year);
  let start, end;

  switch (filter) {
    case "daily":
      end = new Date();
      start = new Date();
      start.setDate(start.getDate() - 30);
      break;
    case "monthly":
      start = new Date(currentYear, 0, 1);
      end = new Date(currentYear, 11, 31, 23, 59, 59);
      break;
    case "yearly":
      start = new Date(currentYear - 4, 0, 1);
      end = new Date(currentYear, 11, 31, 23, 59, 59);
      break;
    default:
      start = new Date(currentYear, 0, 1);
      end = new Date(currentYear, 11, 31, 23, 59, 59);
  }

  return { start, end };
}

function generateDailyPeriods(days) {
  const periods = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    periods.push({
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    });
  }
  return periods;
}

function generateMonthlyPeriods(year) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months.map((month, index) => ({
    label: month,
    year: parseInt(year),
    month: index + 1,
  }));
}

function generateYearlyPeriods(currentYear) {
  const periods = [];
  for (let i = 4; i >= 0; i--) {
    const year = parseInt(currentYear) - i;
    periods.push({ label: year.toString(), year });
  }
  return periods;
}

function matchPeriod(id, period, filter) {
  if (filter === "daily") {
    return id.year === period.year && id.month === period.month && id.day === period.day;
  } else if (filter === "monthly") {
    return id.year === period.year && id.month === period.month;
  }
  return id.year === period.year;
}

/**
 * @desc Get Symbol Performance by Date Range
 * @route GET /api/admin/mis-analytics/symbol-performance/:adminId
 */
export const getSymbolPerformanceByDate = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { filter = "monthly", year = new Date().getFullYear(), symbol } = req.query;

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid adminId" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
      orderStatus: "CLOSED"
    };

    if (symbol) {
      baseMatch.symbol = symbol;
    }

    let groupBy;
    if (filter === "daily") {
      groupBy = {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" },
        day: { $dayOfMonth: "$createdAt" },
        symbol: "$symbol"
      };
    } else if (filter === "monthly") {
      groupBy = {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" },
        symbol: "$symbol"
      };
    } else {
      groupBy = {
        year: { $year: "$createdAt" },
        symbol: "$symbol"
      };
    }

    const symbolDatePerformance = await Order.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: groupBy,
          totalBuyOrders: {
            $sum: { $cond: [{ $eq: ["$type", "BUY"] }, 1, 0] }
          },
          totalSellOrders: {
            $sum: { $cond: [{ $eq: ["$type", "SELL"] }, 1, 0] }
          },
          buyVolume: {
            $sum: { $cond: [{ $eq: ["$type", "BUY"] }, "$volume", 0] }
          },
          sellVolume: {
            $sum: { $cond: [{ $eq: ["$type", "SELL"] }, "$volume", 0] }
          },
          totalProfit: { $sum: "$profit" },
          totalOrders: { $sum: 1 },
          avgPrice: { $avg: "$openingPrice" },
          totalVolume: { $sum: "$volume" },
        },
      },
      {
        $project: {
          date: {
            $dateToString: {
              format: filter === "daily" ? "%Y-%m-%d" : filter === "monthly" ? "%Y-%m" : "%Y",
              date: {
                $dateFromParts: {
                  year: "$_id.year",
                  month: { $ifNull: ["$_id.month", 1] },
                  day: { $ifNull: ["$_id.day", 1] }
                }
              }
            }
          },
          symbol: "$_id.symbol",
          totalBuyOrders: 1,
          totalSellOrders: 1,
          buyVolume: { $round: ["$buyVolume", 2] },
          sellVolume: { $round: ["$sellVolume", 2] },
          totalProfit: { $round: ["$totalProfit", 2] },
          totalOrders: 1,
          avgPrice: { $round: ["$avgPrice", 2] },
          totalVolume: { $round: ["$totalVolume", 2] },
          orderRatio: {
            $cond: [
              { $gt: ["$totalSellOrders", 0] },
              { $round: [{ $divide: ["$totalBuyOrders", "$totalSellOrders"] }, 2] },
              "$totalBuyOrders"
            ]
          },
        },
      },
      { $sort: { date: 1, symbol: 1 } },
    ]);

    // Get top performing symbols
    const topSymbols = await Order.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: "$symbol",
          totalOrders: { $sum: 1 },
          totalProfit: { $sum: "$profit" },
          buyOrders: { $sum: { $cond: [{ $eq: ["$type", "BUY"] }, 1, 0] } },
          sellOrders: { $sum: { $cond: [{ $eq: ["$type", "SELL"] }, 1, 0] } },
        },
      },
      {
        $project: {
          symbol: "$_id",
          totalOrders: 1,
          totalProfit: { $round: ["$totalProfit", 2] },
          buyOrders: 1,
          sellOrders: 1,
        },
      },
      { $sort: { totalOrders: -1 } },
      { $limit: 10 },
    ]);

    return res.status(200).json({
      success: true,
      message: "Symbol performance by date retrieved successfully",
      data: {
        symbolDatePerformance,
        topSymbolsByVolume: topSymbols,
      },
      metadata: {
        filter,
        year,
        symbol: symbol || "all",
        dateRange: { start: dateRange.start, end: dateRange.end },
      },
    });
  } catch (error) {
    console.error("Error fetching symbol performance by date:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch symbol performance",
      error: error.message,
    });
  }
};

/**
 * @desc Get Top Performing Symbols (Buy vs Sell Analysis)
 * @route GET /api/admin/mis-analytics/top-symbols/:adminId
 */
export const getTopSymbols = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { 
      filter = "monthly", 
      year = new Date().getFullYear(),
      limit = 10,
      sortBy = "profit" // profit, volume, orders
    } = req.query;

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid adminId" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
      orderStatus: "CLOSED"
    };

    const topSymbols = await Order.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: "$symbol",
          totalOrders: { $sum: 1 },
          totalBuyOrders: {
            $sum: { $cond: [{ $eq: ["$type", "BUY"] }, 1, 0] }
          },
          totalSellOrders: {
            $sum: { $cond: [{ $eq: ["$type", "SELL"] }, 1, 0] }
          },
          buyVolume: {
            $sum: { $cond: [{ $eq: ["$type", "BUY"] }, "$volume", 0] }
          },
          sellVolume: {
            $sum: { $cond: [{ $eq: ["$type", "SELL"] }, "$volume", 0] }
          },
          totalVolume: { $sum: "$volume" },
          totalProfit: { $sum: "$profit" },
          avgProfit: { $avg: "$profit" },
          maxProfit: { $max: "$profit" },
          minProfit: { $min: "$profit" },
          avgPrice: { $avg: "$openingPrice" },
          uniqueUsers: { $addToSet: "$user" },
        },
      },
      {
        $addFields: {
          userCount: { $size: "$uniqueUsers" },
          profitPerOrder: { $divide: ["$totalProfit", "$totalOrders"] },
          buyPercentage: {
            $multiply: [
              { $divide: ["$totalBuyOrders", "$totalOrders"] },
              100
            ]
          },
          sellPercentage: {
            $multiply: [
              { $divide: ["$totalSellOrders", "$totalOrders"] },
              100
            ]
          },
        },
      },
      {
        $project: {
          symbol: "$_id",
          totalOrders: 1,
          totalBuyOrders: 1,
          totalSellOrders: 1,
          buyVolume: { $round: ["$buyVolume", 2] },
          sellVolume: { $round: ["$sellVolume", 2] },
          totalVolume: { $round: ["$totalVolume", 2] },
          totalProfit: { $round: ["$totalProfit", 2] },
          avgProfit: { $round: ["$avgProfit", 2] },
          maxProfit: { $round: ["$maxProfit", 2] },
          minProfit: { $round: ["$minProfit", 2] },
          avgPrice: { $round: ["$avgPrice", 2] },
          userCount: 1,
          profitPerOrder: { $round: ["$profitPerOrder", 2] },
          buyPercentage: { $round: ["$buyPercentage", 1] },
          sellPercentage: { $round: ["$sellPercentage", 1] },
        },
      },
      {
        $sort: {
          [sortBy === "profit" ? "totalProfit" : sortBy === "volume" ? "totalVolume" : "totalOrders"]: -1
        }
      },
      { $limit: parseInt(limit) },
    ]);

    // Get buy vs sell comparison
    const buySellComparison = topSymbols.map(symbol => ({
      symbol: symbol.symbol,
      buy: symbol.totalBuyOrders,
      sell: symbol.totalSellOrders,
      buyVolume: symbol.buyVolume,
      sellVolume: symbol.sellVolume,
      profit: symbol.totalProfit,
    }));

    return res.status(200).json({
      success: true,
      message: "Top symbols retrieved successfully",
      data: {
        topSymbols,
        buySellComparison,
        summary: {
          totalSymbols: topSymbols.length,
          mostProfitable: topSymbols[0] || null,
          mostTraded: topSymbols.sort((a, b) => b.totalOrders - a.totalOrders)[0] || null,
        }
      },
      metadata: {
        filter,
        year,
        limit: parseInt(limit),
        sortBy,
        dateRange: { start: dateRange.start, end: dateRange.end },
      },
    });
  } catch (error) {
    console.error("Error fetching top symbols:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch top symbols",
      error: error.message,
    });
  }
};

/**
 * @desc Get Transaction Breakdown by Users
 * @route GET /api/admin/mis-analytics/transaction-breakdown/:adminId
 */
export const getTransactionBreakdown = async (req, res) => {
  try {
    const { adminId } = req.params;
    const { filter = "monthly", year = new Date().getFullYear(), limit = 10 } = req.query;

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({ success: false, message: "Invalid adminId" });
    }

    const dateRange = getDateRange(filter, year);
    const baseMatch = {
      adminId: new mongoose.Types.ObjectId(adminId),
      createdAt: { $gte: dateRange.start, $lte: dateRange.end },
      status: "COMPLETED"
    };

    const topUsersByTransactions = await Transaction.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: "$user",
          totalTransactions: { $sum: 1 },
          totalDeposits: {
            $sum: { $cond: [{ $eq: ["$type", "DEPOSIT"] }, "$amount", 0] }
          },
          totalWithdrawals: {
            $sum: { $cond: [{ $eq: ["$type", "WITHDRAWAL"] }, "$amount", 0] }
          },
          depositCount: {
            $sum: { $cond: [{ $eq: ["$type", "DEPOSIT"] }, 1, 0] }
          },
          withdrawalCount: {
            $sum: { $cond: [{ $eq: ["$type", "WITHDRAWAL"] }, 1, 0] }
          },
          avgTransactionAmount: { $avg: "$amount" },
          cashTransactions: {
            $sum: { $cond: [{ $eq: ["$asset", "CASH"] }, 1, 0] }
          },
          goldTransactions: {
            $sum: { $cond: [{ $eq: ["$asset", "GOLD"] }, 1, 0] }
          },
        },
      },
      {
        $lookup: {
          from: "accounts",
          localField: "_id",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      { $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          netFlow: { $subtract: ["$totalDeposits", "$totalWithdrawals"] },
        },
      },
      {
        $project: {
          userId: "$_id",
          name: {
            $concat: [
              { $ifNull: ["$userDetails.firstName", ""] },
              " ",
              { $ifNull: ["$userDetails.lastName", ""] }
            ]
          },
          accountHead: "$userDetails.ACCOUNT_HEAD",
          email: "$userDetails.email",
          accountStatus: "$userDetails.accountStatus",
          totalTransactions: 1,
          totalDeposits: { $round: ["$totalDeposits", 2] },
          totalWithdrawals: { $round: ["$totalWithdrawals", 2] },
          depositCount: 1,
          withdrawalCount: 1,
          avgTransactionAmount: { $round: ["$avgTransactionAmount", 2] },
          cashTransactions: 1,
          goldTransactions: 1,
          netFlow: { $round: ["$netFlow", 2] },
        },
      },
      { $sort: { totalDeposits: -1 } },
      { $limit: parseInt(limit) },
    ]);

    // Asset breakdown
    const assetBreakdown = await Transaction.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: "$asset",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
      {
        $project: {
          asset: "$_id",
          count: 1,
          totalAmount: { $round: ["$totalAmount", 2] },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      message: "Transaction breakdown retrieved successfully",
      data: {
        topUsersByTransactions,
        assetBreakdown,
      },
      metadata: {
        filter,
        year,
        limit: parseInt(limit),
        dateRange: { start: dateRange.start, end: dateRange.end },
      },
    });
  } catch (error) {
    console.error("Error fetching transaction breakdown:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transaction breakdown",
      error: error.message,
    });
  }
};