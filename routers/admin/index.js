import express from "express";
import {
  getAllData,
  updateAccountType,
  getAccountByType,
  updateMarginAmount,
  updateFavoriteStatus,
  filterAccounts,
  insertAccount,
  updateAccount,
  deleteAccount,
  getUserProfile,
  updateUserProfile,
  adminTokenVerificationApi,
  updateBalance,
  getBalance,
  freezeAccount,
  sendAlertFunction,
} from "../../controllers/admin/accountControllers.js";
import {
  getAdminProfile,
  loginAdmin,
} from "../../controllers/superAdmin/adminControllers.js";
import {
  createTrade,
  getUserTrades,
  updateTrade,
  getLPTrades,
  getUserOrdersByAdmin,
  getLPProfitOrdersByAdmin,
} from "../../controllers/admin/tradingController.js";
import {
  createTransaction,
  getAllTransactions,
  getUserTransactionsByAdmin,
  getLedgerData,
} from "../../controllers/admin/transactionController.js";

import {
  getChartData,
  getMISOverview,
  getSymbolAnalysis,
  getSymbolPerformanceByDate,
  getTopSymbols,
  getTopUsersByOrders,
  getTransactionBreakdown,
  getUserActivity,
} from "../../controllers/admin/dashboardController.js";
const router = express.Router();
router.post("/login", loginAdmin);
router.get("/fetch-data/:adminId", getAllData);
router.post("/verify-token", adminTokenVerificationApi);
router.put("/update-accountType/:adminId", updateAccountType);
router.get("/account-type", getAccountByType);
router.put("/update-margin/:adminId", updateMarginAmount);
router.put("/update-favorite/:adminId", updateFavoriteStatus);
router.get("/fetch-filter", filterAccounts);
//profile management
router.put("/update-balance/:userId", updateBalance);
router.get("/balance/:userId", getBalance);
router.post("/accounts/:adminId", insertAccount);
router.put("/accounts/:ACCODE/:adminId", updateAccount);
router.delete("/accounts/:ACCODE/:adminId", deleteAccount);
router.get("/profile/:adminId", getAdminProfile);
router.get("/user-profile/:adminId/:userId", getUserProfile);
router.put("/user-profile/:adminId/:userId", updateUserProfile);
//order management
router.post("/create-order/:adminId", createTrade);
router.get("/order/:adminId", getUserTrades);
router.get("/lp-order/:adminId", getLPTrades);
router.patch("/order/:adminId/:orderId", updateTrade);
router.get("/user-orders/:adminId/:userId", getUserOrdersByAdmin);
router.post("/send-alert/:userId", sendAlertFunction);
router.put("/freeze-account/:userId", freezeAccount);
router.get("/LPProfit", getLPProfitOrdersByAdmin); // Assuming this is for LPProfit, adjust if needed
//transaction management
router.post("/create-transaction/:adminId", createTransaction);
router.get("/fetch-transaction", getAllTransactions);
router.get("/user-transactions/:adminId/:userId", getUserTransactionsByAdmin);
//ledger management
router.get("/fetch-ledger", getLedgerData);
//overview and analytics
router.get("/overview/:adminId", getMISOverview);
// User performance endpoints
router.get("/top-users/:adminId", getTopUsersByOrders);
router.get("/user-activity/:adminId/:userId", getUserActivity);
router.get("/transaction-breakdown/:adminId", getTransactionBreakdown);
// Symbol analysis endpoints
router.get("/symbol-analysis/:adminId", getSymbolAnalysis);
router.get("/symbol-performance/:adminId", getSymbolPerformanceByDate);
router.get("/top-symbols/:adminId", getTopSymbols);

// Chart data endpoint
router.get("/charts/:adminId", getChartData);

export default router;
