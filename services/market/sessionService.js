import { cleanPhoneNumber } from "../../utils/helpers.js";
import { storeUserOrdersInSession } from "../../services/market/orderService.js";

const userSessions = {};

export const getUserSession = (phoneNumber) => {
  const cleanNumber = cleanPhoneNumber(phoneNumber);
  if (!userSessions[cleanNumber]) {
    userSessions[cleanNumber] = {
      state: "MAIN_MENU", // Changed from "START" to match controller
      cart: {},
      lastActivity: Date.now(),
      currentOrder: null,
      accountId: null,
      adminId: null,
      openOrders: [],
      tradingMode: "mt5",
      userName: null,
      pendingOrder: null,
      openPositions: null,
      symbol: "TTBAR", // Default symbol aligned with CRM trade service
    };
  }
  userSessions[cleanNumber].lastActivity = Date.now();
  storeUserOrdersInSession(userSessions[cleanNumber]); // Pre-fetch orders
  return userSessions[cleanNumber];
};

export const updateUserSession = (phoneNumber, sessionData) => {
  const cleanNumber = cleanPhoneNumber(phoneNumber);
  if (!userSessions[cleanNumber]) {
    userSessions[cleanNumber] = {
      state: "MAIN_MENU",
      cart: {},
      lastActivity: Date.now(),
      currentOrder: null,
      accountId: null,
      adminId: null,
      openOrders: [],
      tradingMode: "mt5",
      userName: null,
      pendingOrder: null,
      openPositions: null,
      symbol: "TTBAR",
    };
  }
  userSessions[cleanNumber] = {
    ...userSessions[cleanNumber],
    ...sessionData,
    lastActivity: Date.now(),
  };
  storeUserOrdersInSession(userSessions[cleanNumber]);
  return userSessions[cleanNumber];
};

export const resetSession = (phoneNumber) => {
  const cleanNumber = cleanPhoneNumber(phoneNumber);
  userSessions[cleanNumber] = {
    state: "MAIN_MENU",
    cart: {},
    lastActivity: Date.now(),
    currentOrder: null,
    accountId: null,
    adminId: null,
    openOrders: [],
    tradingMode: "mt5",
    userName: null,
    pendingOrder: null,
    openPositions: null,
    symbol: "TTBAR",
  };
  storeUserOrdersInSession(userSessions[cleanNumber]);
};