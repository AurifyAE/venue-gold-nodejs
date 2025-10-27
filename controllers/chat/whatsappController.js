import pkg from "twilio";
const { Twilio, twiml } = pkg;
const { MessagingResponse } = twiml;
import dotenv from "dotenv";
import {
  getUserSession,
  updateUserSession,
  resetSession,
} from "../../services/market/sessionService.js";
import { isAuthorizedUser } from "../../services/market/userService.js";
import {
  getPriceMessageMT5,
  processUserInputMT5,
  getMainMenuMT5,
  getPositionsMessageMT5,
} from "../../services/market/messageService.js";
import { getUserBalance } from "../../services/market/balanceService.js";
import mt5MarketDataService from "../../services/Trading/mt5MarketDataService.js";
import mt5Service from "../../services/Trading/mt5Service.js";
import {
  createTrade,
  updateTradeStatus,
} from "../../services/Trading/tradingServices.js";
import mongoose from "mongoose";
import Account from "../../models/AccountSchema.js";
import Order from "../../models/OrderSchema.js";

// Initialize environment variables
dotenv.config();

// Initialize Twilio client
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_WHATSAPP_NUMBER;
const client = new Twilio(accountSid, authToken);

// Inline formatCurrency function
export const formatCurrency = (amount) => {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount || 0);
};

// Constants
const GRAMS_PER_BAR = { TTBAR: 117, KGBAR: 1000 };
const CONVERSION_FACTORS = { TTBAR: 13.7628, KGBAR: 32.1507 * 3.674 };
const SYMBOL_MAPPING = {
  TTBAR: process.env.MT5_SYMBOL || "XAUUSD.gm",
  KGBAR: process.env.MT5_SYMBOL || "XAUUSD.gm",
};
const UNAUTHORIZED_MESSAGE = `🚫 Access Denied\nYour number is not registered.\n\n📞 Support: Ajmal TK +971 58 502 3411`;

// Deduplication
const messageProcessingState = new Map();
const MESSAGE_CACHE_TTL = 300000;
const PROCESSING_TIMEOUT = 30000;
const PROCESSING_STATES = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

// Utility functions
const generateEntryId = (prefix) => {
  const timestamp = Date.now().toString();
  const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp.substring(timestamp.length - 5)}-${randomStr}`;
};

const isDuplicateMessage = (messageSid, from, body) => {
  const primaryKey = messageSid;
  const fallbackKey = `${from}:${body}:${Math.floor(Date.now() / 1000)}`;
  const existingState =
    messageProcessingState.get(primaryKey) ||
    messageProcessingState.get(fallbackKey);

  if (existingState) {
    const timeDiff = Date.now() - existingState.timestamp;
    if (
      existingState.state === PROCESSING_STATES.PROCESSING ||
      (existingState.state === PROCESSING_STATES.COMPLETED && timeDiff < 5000)
    ) {
      return true;
    }
    if (
      existingState.state === PROCESSING_STATES.FAILED &&
      timeDiff > PROCESSING_TIMEOUT
    ) {
      messageProcessingState.delete(primaryKey);
      messageProcessingState.delete(fallbackKey);
    }
  }
  return false;
};

const markMessageProcessing = (messageSid, from, body) => {
  const primaryKey = messageSid;
  const fallbackKey = `${from}:${body}:${Math.floor(Date.now() / 1000)}`;
  const processingData = {
    state: PROCESSING_STATES.PROCESSING,
    timestamp: Date.now(),
  };
  messageProcessingState.set(primaryKey, processingData);
  messageProcessingState.set(fallbackKey, processingData);

  setTimeout(() => {
    const current = messageProcessingState.get(primaryKey);
    if (current && current.state === PROCESSING_STATES.PROCESSING) {
      messageProcessingState.set(primaryKey, {
        ...current,
        state: PROCESSING_STATES.FAILED,
      });
    }
  }, PROCESSING_TIMEOUT);

  return { primaryKey, fallbackKey };
};

const markMessageComplete = (keys, success = true) => {
  const state = success
    ? PROCESSING_STATES.COMPLETED
    : PROCESSING_STATES.FAILED;
  keys.forEach((key) => {
    messageProcessingState.set(key, { state, timestamp: Date.now() });
  });
  setTimeout(
    () => keys.forEach((key) => messageProcessingState.delete(key)),
    MESSAGE_CACHE_TTL
  );
};

const getUserIdFromPhoneNumber = async (phoneNumber) => {
  try {
    let cleanPhoneNumber = phoneNumber.replace(/^(whatsapp:)?[\+\s\-()]/g, "");
    const queryVariations = [
      cleanPhoneNumber,
      `+${cleanPhoneNumber}`,
      cleanPhoneNumber.startsWith("91")
        ? cleanPhoneNumber.slice(2)
        : `91${cleanPhoneNumber}`,
      `whatsapp:${cleanPhoneNumber}`,
      `whatsapp:+${cleanPhoneNumber}`,
    ];

    const account = await Account.findOne({
      phoneNumber: { $in: queryVariations },
    }).lean();
    if (!account)
      return { userId: null, adminId: null, error: "Account not found" };

    const userId = account._id.toString();
    const adminId = account.addedBy ? account.addedBy.toString() : null;
    return !adminId
      ? { userId, adminId: null, error: "Admin ID not found" }
      : { userId, adminId, error: null };
  } catch (error) {
    console.error(`Error fetching userId: ${error.message}`);
    return { userId: null, adminId: null, error: error.message };
  }
};

const calculateTradeCost = (price, volume, symbol = "TTBAR") => {
  console.log("+++++++++++++++++++++++++++++++");
  console.log(price, volume);
  console.log("+++++++++++++++++++++++++++++++");
  // const grams = GRAMS_PER_BAR[symbol] * volume;
  return price * volume;
};

const checkSufficientBalance = async (
  price,
  volume,
  phoneNumber,
  symbol = "TTBAR"
) => {
  try {
    const { userId, adminId } = await getUserIdFromPhoneNumber(phoneNumber);
    if (!userId)
      return { isSufficient: false, errorMessage: "User account not found" };

    const account = await Account.findById(userId).lean();
    if (!account || account.reservedAmount === undefined) {
      return {
        isSufficient: false,
        errorMessage: "User account information not available",
      };
    }

    if (account.isFreeze === true) {
      let adminContact = "your admin at +971 58 185 7903";
      if (adminId) {
        const adminAccount = await Account.findById(adminId)
          .select("phoneNumber")
          .lean();
        if (adminAccount && adminAccount.phoneNumber) {
          adminContact = `your admin at +${adminAccount.phoneNumber}`;
        }
      }
      return {
        isSufficient: false,
        errorMessage: `Account is frozen. Please contact ${adminContact}`,
      };
    }

    const volumeValue = parseFloat(volume) || 0;
    if (volumeValue <= 0) {
      return {
        isSufficient: false,
        errorMessage: "Volume must be at least 0.1",
      };
    }
    console.log(price, volume);

    const availableBalance = parseFloat(account.reservedAmount) || 0;
    const tradeCost = calculateTradeCost(price, volumeValue, symbol);
    console.log(tradeCost);

    const marginRequirement = tradeCost * (account.margin / 100);
    console.log(marginRequirement);

    if (marginRequirement > availableBalance) {
      return {
        isSufficient: false,
        errorMessage: `Insufficient balance.\nRequired: AED ${formatCurrency(
          marginRequirement
        )}\nAvailable: AED ${formatCurrency(availableBalance)}`,
      };
    }

    return { isSufficient: true, errorMessage: null };
  } catch (error) {
    console.error(`Balance check error: ${error.message}`);
    return {
      isSufficient: false,
      errorMessage: "Error checking balance. Try again.",
    };
  }
};

const sendMessage = async (to, message, retries = 2) => {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const formattedTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
      const formattedFrom = twilioPhoneNumber.startsWith("whatsapp:")
        ? twilioPhoneNumber
        : `whatsapp:${twilioPhoneNumber}`;
      const twilioMessage = await client.messages.create({
        body: message,
        from: formattedFrom,
        to: formattedTo,
      });
      console.log(`Message sent to ${to}, SID: ${twilioMessage.sid}`);
      return { success: true, sid: twilioMessage.sid };
    } catch (error) {
      lastError = error;
      console.error(
        `Twilio error to ${to} (Attempt ${attempt + 1}): ${error.message}`
      );
      if (error.code === 63016 || error.code === 21211) break;
      if (attempt < retries)
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1))
        );
    }
  }
  return { success: false, error: lastError };
};

const executeInTransaction = async (operation, maxRetries = 3) => {
  let attempt = 0;
  let lastError;
  while (attempt < maxRetries) {
    const mongoSession = await mongoose.startSession();
    let transactionStarted = false;
    let transactionCommitted = false;

    try {
      mongoSession.startTransaction();
      transactionStarted = true;
      const result = await operation(mongoSession);
      await mongoSession.commitTransaction();
      transactionCommitted = true;
      return { success: true, result };
    } catch (error) {
      lastError = error;
      if (transactionStarted && !transactionCommitted) {
        await mongoSession.abortTransaction();
      }
      console.error(
        `Transaction failed (attempt ${attempt + 1}): ${error.message}`
      );
      if (
        error.message.includes("already closed") ||
        error.message.includes("not found")
      )
        break;
      attempt++;
      if (attempt < maxRetries)
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    } finally {
      await mongoSession.endSession();
    }
  }
  return { success: false, error: lastError };
};

// Handle main menu with direct order execution
export const handleMainMenuMT5 = async (
  input,
  session,
  phoneNumber,
  account,
  marketData,
  symbol = "TTBAR"
) => {
  const unit = symbol === "KGBAR" ? "KG" : "GRAM";
  const inputParts = input.trim().toLowerCase().split(/\s+/);
  const command = inputParts[0];
  const volumeInput = inputParts[1];

  if (["buy", "sell"].includes(command) && volumeInput) {
    const volume = parseFloat(volumeInput);
    if (isNaN(volume) || volume <= 0) {
      return `❌ Invalid volume. Type MENU.`;
    }

    session.pendingOrder = { type: command.toUpperCase(), symbol, volume };
    updateUserSession(phoneNumber, session);
    return await executeOrderDirectly(
      session,
      phoneNumber,
      account,
      marketData,
      symbol
    );
  }

  switch (input.toLowerCase()) {
    case "1":
    case "buy":
      session.state = "AWAITING_VOLUME";
      session.pendingOrder = { type: "BUY", symbol };
      updateUserSession(phoneNumber, session);
      const adjustedAsk = (
        marketData?.ask * CONVERSION_FACTORS[symbol] +
        (account.askSpread || 0)
      ).toFixed(2);
      return `📈 Buy ${symbol} at AED ${adjustedAsk}/${unit}\nVolume (e.g., 1):`;
    case "2":
    case "sell":
      session.state = "AWAITING_VOLUME";
      session.pendingOrder = { type: "SELL", symbol };
      updateUserSession(phoneNumber, session);
      const adjustedBid = (
        marketData?.bid * CONVERSION_FACTORS[symbol] -
        (account.bidSpread || 0)
      ).toFixed(2);
      return `📉 Sell ${symbol} at AED ${adjustedBid}/${unit}\nVolume (e.g., 1):`;
    case "3":
    case "balance":
      const balance = await getUserBalance(session.accountId, phoneNumber);
      return `💰 Balance 💸\nEquity: AED ${formatCurrency(
        account?.AMOUNTFC || balance.cash
      )}\nAvailable: AED ${formatCurrency(
        account?.reservedAmount || balance.cash
      )}\n\n💬 MENU`;
    case "4":
    case "positions":
      return await getPositionsMessageMT5(session, phoneNumber, symbol);
    case "5":
    case "price":
      return await getPriceMessageMT5(
        symbol,
        account.askSpread || 0,
        account.bidSpread || 0
      );
    default:
      return await getMainMenuMT5(
        marketData,
        symbol,
        session.userName,
        account.askSpread || 0,
        account.bidSpread || 0
      );
  }
};

// Direct order execution (enhanced success message)
const executeOrderDirectly = async (
  session,
  phoneNumber,
  account,
  marketData,
  symbol
) => {
  const { volume, type: orderType } = session.pendingOrder;
  const unit = symbol === "KGBAR" ? "KG" : "GRAM";
  const adjustedPrice =
    orderType === "BUY"
      ? marketData?.ask * CONVERSION_FACTORS[symbol] + (account.askSpread || 0)
      : marketData?.bid * CONVERSION_FACTORS[symbol] - (account.bidSpread || 0);

  if (!marketData || !marketData.ask || !marketData.bid) {
    session.state = "MAIN_MENU";
    session.pendingOrder = null;
    updateUserSession(phoneNumber, session);
    return `❌ Market unavailable. Type MENU.`;
  }

  const balanceCheck = await checkSufficientBalance(
    adjustedPrice,
    volume,
    phoneNumber,
    symbol
  );
  if (!balanceCheck.isSufficient) {
    session.state = "MAIN_MENU";
    session.pendingOrder = null;
    updateUserSession(phoneNumber, session);
    return `❌ ${balanceCheck.errorMessage}\nType MENU.`;
  }

  try {
    const result = await executeInTransaction(async (mongoSession) => {
      const { userId, adminId } = await getUserIdFromPhoneNumber(phoneNumber);
      if (!userId || !adminId) throw new Error("User or admin not found");

      const accountDoc = await Account.findById(userId)
        .session(mongoSession)
        .lean();
      if (!accountDoc) throw new Error("User account not found");

      const orderNo = generateEntryId("OR");
      const grams = GRAMS_PER_BAR[symbol] * volume;
      const totalCost = calculateTradeCost(adjustedPrice, volume, symbol);
      const requiredMargin = totalCost * (accountDoc.margin / 100);

      const tradeData = {
        symbol: SYMBOL_MAPPING[symbol],
        volume: grams,
        type: orderType,
        slDistance: null,
        tpDistance: null,
        comment: `Ord-${orderNo}`,
        magic: 123456,
      };

      const mt5Result = await mt5Service.placeTrade(tradeData);
      console.log(mt5Result);
      if (!mt5Result.success || !mt5Result.price || !mt5Result.ticket) {
        throw new Error(mt5Result.error || "MT5 trade failed");
      }

      const actualExecutionPrice = parseFloat(mt5Result.price);
      const clientPricePerGram =
        (actualExecutionPrice +
          (orderType === "BUY" ? accountDoc.askSpread : -accountDoc.bidSpread)) *
        CONVERSION_FACTORS[symbol] *
        volume;

      console.log(clientPricePerGram);
      console.log(actualExecutionPrice);
      console.log(volume);
      console.log(accountDoc.askSpread);
      console.log(accountDoc.bidSpread);
      const crmTradeData = {
        orderNo,
        type: orderType,
        volume: grams,
        ticket: mt5Result.ticket.toString(),
        symbol,
        openingPrice: clientPricePerGram,
        price: clientPricePerGram,
        openingDate: new Date(),
        requiredMargin,
        comment: `Ord-${orderNo}`,
        stopLoss: session.pendingOrder?.stopLoss || 0,
        takeProfit: session.pendingOrder?.takeProfit || 0,
      };
      console.log("first");
      console.log(crmTradeData);
      const tradeResult = await createTrade(
        adminId,
        userId,
        crmTradeData,
        mongoSession
      );
      return {
        tradeResult,
        actualPrice: clientPricePerGram,
        ticket: mt5Result.ticket,
      };
    });

    if (!result.success) throw new Error(result.error.message);

    const { tradeResult, actualPrice, ticket } = result.result;
    session.state = "MAIN_MENU";
    session.pendingOrder = null;
    updateUserSession(phoneNumber, session);

    // Enhanced, attractive success message
    const totalValue = calculateTradeCost(actualPrice, volume, symbol);
    return `🎉 ${orderType} ${volume} ${symbol} Executed! 🚀\n📌 Price: AED ${actualPrice.toFixed(
      2
    )}\n🎫 Ticket: #${ticket}\n\n💬 4=Positions | MENU`;
  } catch (error) {
    console.error(`Direct order error: ${error.message}`);
    session.state = "MAIN_MENU";
    session.pendingOrder = null;
    updateUserSession(phoneNumber, session);
    return `❌ Error: ${error.message}\nType MENU.`;
  }
};

// Handle volume input
export const handleVolumeInputMT5 = async (
  input,
  session,
  phoneNumber,
  account,
  marketData,
  symbol
) => {
  const unit = symbol === "KGBAR" ? "KG" : "GRAM";
  const typePrefix = session.pendingOrder.type === "BUY" ? "Buy" : "Sell";

  if (input.toLowerCase() === "menu") {
    session.state = "MAIN_MENU";
    session.pendingOrder = null;
    updateUserSession(phoneNumber, session);
    return await getMainMenuMT5(
      marketData,
      symbol,
      session.userName,
      account.askSpread || 0,
      account.bidSpread || 0
    );
  }

  const volume = parseFloat(input);
  if (isNaN(volume) || volume <= 0) {
    const adjustedPrice =
      session.pendingOrder.type === "BUY"
        ? (
          marketData?.ask * CONVERSION_FACTORS[symbol] +
          (account.askSpread || 0)
        ).toFixed(2)
        : (
          marketData?.bid * CONVERSION_FACTORS[symbol] -
          (account.bidSpread || 0)
        ).toFixed(2);
    return `❌ Invalid volume. >0 (e.g., 0.1 ${unit.toLowerCase()})\n\n📈 ${typePrefix} ${symbol} at AED ${adjustedPrice}/${unit}\nVolume:`;
  }

  session.pendingOrder.volume = volume;
  session.pendingOrder.price =
    session.pendingOrder.type === "BUY"
      ? marketData?.ask * CONVERSION_FACTORS[symbol] + (account.askSpread || 0)
      : marketData?.bid * CONVERSION_FACTORS[symbol] - (account.bidSpread || 0);
  session.state = "CONFIRM_ORDER";
  updateUserSession(phoneNumber, session);

  return `📝 Confirm ${typePrefix} 📋\n${symbol} | ${volume} ${unit}\nPrice: AED ${session.pendingOrder.price.toFixed(
    2
  )}/${unit}\nTotal: AED ${formatCurrency(
    calculateTradeCost(session.pendingOrder.price, volume, symbol)
  )}\n\n💬 YES or MENU`;
};

// Handle order confirmation
export const handleOrderConfirmationMT5 = async (
  input,
  session,
  phoneNumber,
  account
) => {
  const symbol = session.symbol || "TTBAR";
  const marketData = await mt5MarketDataService.getMarketData(
    SYMBOL_MAPPING[symbol]
  );
  const unit = symbol === "KGBAR" ? "KG" : "GRAM";

  if (input.toLowerCase() === "menu" || input.toLowerCase() === "no") {
    session.state = "MAIN_MENU";
    session.pendingOrder = null;
    updateUserSession(phoneNumber, session);
    return `❌ Cancelled\n\n${await getMainMenuMT5(
      marketData,
      symbol,
      session.userName,
      account.askSpread || 0,
      account.bidSpread || 0
    )}`;
  }

  if (input.toLowerCase() === "yes") {
    const { volume, price, type: orderType } = session.pendingOrder;
    const balanceCheck = await checkSufficientBalance(
      price,
      volume,
      phoneNumber,
      symbol
    );
    if (!balanceCheck.isSufficient) {
      session.state = "MAIN_MENU";
      session.pendingOrder = null;
      updateUserSession(phoneNumber, session);
      return `❌ ${balanceCheck.errorMessage}\nType MENU.`;
    }

    try {
      const result = await executeInTransaction(async (mongoSession) => {
        const { userId, adminId } = await getUserIdFromPhoneNumber(phoneNumber);
        if (!userId || !adminId) throw new Error("User or admin not found");

        const accountDoc = await Account.findById(userId)
          .session(mongoSession)
          .lean();
        if (!accountDoc) throw new Error("User account not found");

        const orderNo = generateEntryId("OR");
        const grams = GRAMS_PER_BAR[symbol] * volume;
        const totalCost = calculateTradeCost(price, volume, symbol);
        const requiredMargin = totalCost * (accountDoc.margin / 100);
        console.log(requiredMargin);

        const tradeData = {
          symbol: SYMBOL_MAPPING[symbol],
          volume: grams,
          type: orderType,
          slDistance: null,
          tpDistance: null,
          comment: `Ord-${orderNo}`,
          magic: 123456,
        };

        const mt5Result = await mt5Service.placeTrade(tradeData);
        if (!mt5Result.success || !mt5Result.price || !mt5Result.ticket) {
          throw new Error(mt5Result.error || "MT5 trade failed");
        }

        const actualExecutionPrice = parseFloat(mt5Result.price);
        const clientPricePerGram =
          (actualExecutionPrice +
            (orderType === "BUY" ? accountDoc.askSpread : -accountDoc.bidSpread)) *
          CONVERSION_FACTORS[symbol] *
          volume;

        console.log(clientPricePerGram);
        console.log(actualExecutionPrice);

        const crmTradeData = {
          orderNo,
          type: orderType,
          volume: grams,
          ticket: mt5Result.ticket.toString(),
          symbol,
          openingPrice: clientPricePerGram,
          price: clientPricePerGram,
          openingDate: new Date(),
          requiredMargin,
          comment: `Ord-${orderNo}`,
          stopLoss: session.pendingOrder?.stopLoss || 0,
          takeProfit: session.pendingOrder?.takeProfit || 0,
        };
        console.log("first");
        console.log(crmTradeData);

        const tradeResult = await createTrade(
          adminId,
          userId,
          crmTradeData,
          mongoSession
        );
        return {
          tradeResult,
          actualPrice: clientPricePerGram,
          ticket: mt5Result.ticket,
        };
      });

      if (!result.success) throw new Error(result.error.message);

      const { tradeResult, actualPrice, ticket } = result.result;
      session.state = "MAIN_MENU";
      session.pendingOrder = null;
      updateUserSession(phoneNumber, session);
      console.log(actualPrice);

      // Enhanced, attractive success message
      const totalValue = calculateTradeCost(actualPrice, volume, symbol);
      return `🎉 ${orderType} ${volume} ${symbol} Executed! 🚀\n📌 Price: AED ${actualPrice.toFixed(
        2
      )}\n🎫 Ticket: #${ticket}\n\n💬 4=Positions | MENU`;
    } catch (error) {
      console.error(`Order confirmation error: ${error.message}`);
      session.state = "MAIN_MENU";
      session.pendingOrder = null;
      updateUserSession(phoneNumber, session);
      return `❌ Error: ${error.message}\nType MENU.`;
    }
  }

  return `ℹ️ YES or MENU`;
};

// Handle position selection and closing (fixed closePosition error)
export const handlePositionSelectionMT5 = async (
  input,
  session,
  phoneNumber
) => {
  const symbol = session.symbol || "TTBAR";
  const marketData = await mt5MarketDataService.getMarketData(
    SYMBOL_MAPPING[symbol]
  );
  const unit = symbol === "KGBAR" ? "KG" : "GRAM";

  if (input.toLowerCase() === "menu") {
    session.state = "MAIN_MENU";
    session.openPositions = null;
    updateUserSession(phoneNumber, session);
    return await getMainMenuMT5(marketData, symbol, session.userName);
  }

  const positionIndex = parseInt(input) - 1;
  if (
    !session.openPositions ||
    positionIndex < 0 ||
    positionIndex >= session.openPositions.length
  ) {
    return `❌ Invalid number. Type MENU.\n\n${await getPositionsMessageMT5(
      session,
      phoneNumber,
      symbol
    )}`;
  }

  const selectedPosition = session.openPositions[positionIndex];
  if (!selectedPosition.ticket || !selectedPosition.volume) {
    console.error(`Invalid position data: ${JSON.stringify(selectedPosition)}`);
    return `❌ Invalid position. Type MENU.\n\n${await getPositionsMessageMT5(
      session,
      phoneNumber,
      symbol
    )}`;
  }

  try {
    const result = await executeInTransaction(async (mongoSession) => {
      const { userId, adminId } = await getUserIdFromPhoneNumber(phoneNumber);
      if (!userId || !adminId) throw new Error("User or admin not found");

      const order = await Order.findOne({
        ticket: selectedPosition.ticket,
        adminId,
      })
        .session(mongoSession)
        .lean();
      if (!order)
        throw new Error(
          `Order not found for ticket: ${selectedPosition.ticket}`
        );
      if (order.orderStatus === "CLOSED")
        throw new Error(`Order ${selectedPosition.ticket} is already closed`);

      // Close the position using MT5 closeTrade function
      let closeResult;
      try {
        // Use the proper closeTrade method that closes the position
        const mt5Symbol = SYMBOL_MAPPING[symbol] || symbol;
        const validatedSymbol = await mt5Service.validateSymbol(mt5Symbol);

        const mt5CloseData = {
          ticket: selectedPosition.ticket,
          symbol: validatedSymbol,
          volume: parseFloat(selectedPosition.volume),
          type: selectedPosition.type === "BUY" ? "SELL" : "BUY", // Opposite type to close
          openingPrice: parseFloat(selectedPosition.price_open),
        };

        closeResult = await mt5Service.closeTrade(mt5CloseData);

        // Handle position already closed or not found
        if (!closeResult.success) {
          if (
            closeResult.error.includes("Position not found") ||
            closeResult.likelyClosed
          ) {
            // Position already closed, get current price for calculation
            const priceData = await mt5Service.getPrice(validatedSymbol);
            if (priceData && priceData.bid && priceData.ask) {
              const mt5ClosingPrice =
                selectedPosition.type === "BUY"
                  ? parseFloat(priceData.bid)
                  : parseFloat(priceData.ask);
              
              closeResult = {
                success: true,
                price: mt5ClosingPrice,
                volume: selectedPosition.volume,
                closePrice: mt5ClosingPrice,
              };
            } else {
              throw new Error("Unable to get closing price for already closed position");
            }
          } else {
            throw new Error(`MT5 close failed: ${closeResult.error}`);
          }
        }
      } catch (closeError) {
        console.error(`MT5 close error: ${closeError.message}`);
        throw new Error(`Failed to close position: ${closeError.message}`);
      }

      if (!closeResult.success || (!closeResult.price && !closeResult.closePrice)) {
        throw new Error(closeResult.error || "Failed to close position in MT5");
      }

      const grams = parseFloat(selectedPosition.volume) / GRAMS_PER_BAR[symbol];
      console.log(`Closing grams: ${grams}`);
      
      // Get the actual closing price from MT5 response
      const mt5Price = parseFloat(closeResult.closePrice || closeResult.price);
      const closingPrice = mt5Price * CONVERSION_FACTORS[symbol] * grams;

      const updateData = {
        orderStatus: "CLOSED",
        closingPrice,
        closingDate: new Date(),
      };

      // updateTradeStatus returns the complete trade info including calculated profit
      const updatedOrder = await updateTradeStatus(
        adminId,
        order._id.toString(),
        updateData,
        mongoSession
      );

      // Extract values from updateTradeStatus response
      const clientProfit = updatedOrder.profit.client;
      const openingPrice = parseFloat(order.openingPrice);

      return { 
        updatedOrder, 
        closingPrice, 
        openingPrice,
        profit: clientProfit 
      };
    });

    if (!result.success) throw new Error(result.error.message);

    const { updatedOrder, closingPrice, openingPrice, profit } = result.result;
    session.state = "MAIN_MENU";
    session.openPositions = null;
    updateUserSession(phoneNumber, session);

    // Calculate per-unit prices for display
    const grams = selectedPosition.volume / GRAMS_PER_BAR[symbol];
    const openPricePerUnit = openingPrice / grams;
    const closePricePerUnit = closingPrice / grams;

    // Enhanced, attractive close message with profit/loss indicator
    const profitEmoji = profit >= 0 ? "💰" : "📉";
    const profitText = profit >= 0 ? "Profit" : "Loss";
    const profitColor = profit >= 0 ? "+" : "";

    return `🎉 Position #${selectedPosition.ticket} Closed! ✅

📊 *Trade Summary*
━━━━━━━━━━━━━━━━
📈 Open:  AED ${openPricePerUnit.toFixed(2)}/${unit}
📉 Close: AED ${closePricePerUnit.toFixed(2)}/${unit}
${profitEmoji} ${profitText}: ${profitColor}AED ${Math.abs(profit).toFixed(2)}

💰 Total: AED ${closingPrice.toFixed(2)}

💬 4=Positions | MENU`;
  } catch (error) {
    console.error(
      `Position close error for ticket ${selectedPosition.ticket}: ${error.message}`
    );
    return `❌ Close error: ${error.message}\nType MENU.`;
  }
};

// Main webhook handler
export const handleWhatsAppWebhook = async (req, res) => {
  const { Body, From, ProfileName, MessageSid } = req.body;

  if (!Body || !From || !MessageSid) {
    console.log("Missing parameters:", req.body);
    return res.status(400).send("Missing required parameters");
  }

  if (isDuplicateMessage(MessageSid, From, Body)) {
    console.log(`Duplicate request detected: ${MessageSid} from ${From}`);
    return res.status(200).send(new MessagingResponse().toString());
  }

  const processingKeys = markMessageProcessing(MessageSid, From, Body);
  res.status(200).send(new MessagingResponse().toString());

  let success = false;
  try {
    const authResult = await isAuthorizedUser(From);
    if (!authResult.isAuthorized) {
      await sendMessage(From, UNAUTHORIZED_MESSAGE);
      success = true;
      return;
    }

    const { userId, adminId, error } = await getUserIdFromPhoneNumber(From);
    if (!userId || !adminId) {
      await sendMessage(
        From,
        `❌ Error: ${error || "User or admin not found"}`
      );
      success = false;
      return;
    }

    const account = await Account.findById(userId).lean();
    if (!account) {
      await sendMessage(From, `❌ Error: User account not found`);
      success = false;
      return;
    }

    const symbol = account?.symbol || "TTBAR";
    const session = getUserSession(From);
    session.accountId = authResult.accountId;
    session.phoneNumber = From;
    session.tradingMode = "mt5";
    session.symbol = symbol;
    if (ProfileName && !session.userName) session.userName = ProfileName;
    updateUserSession(From, session);

    const marketData = await mt5MarketDataService.getMarketData(
      SYMBOL_MAPPING[symbol]
    );
    const responseMessage = await processUserInputMT5(
      Body,
      session,
      client,
      From,
      twilioPhoneNumber,
      From,
      account
    );

    if (responseMessage) {
      const sendResult = await sendMessage(From, responseMessage);
      success = sendResult.success;
    } else {
      success = true;
    }
  } catch (error) {
    console.error(`Webhook error for ${MessageSid}: ${error.message}`);
    await sendMessage(From, `❌ Error: ${error.message}\nType MENU.`);
    success = false;
  } finally {
    markMessageComplete(
      [processingKeys.primaryKey, processingKeys.fallbackKey],
      success
    );
  }
};

// Health check endpoint
export const healthCheck = (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "WhatsApp Webhook Handler",
    processingMessages: messageProcessingState.size,
  });
};