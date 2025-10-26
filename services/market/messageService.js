import mt5MarketDataService from "../Trading/mt5MarketDataService.js";
import mt5Service from "../Trading/mt5Service.js";
import { getUserBalance } from "./balanceService.js";
import { updateUserSession } from "./sessionService.js";
import { createTrade, updateTradeStatus } from "../Trading/tradingServices.js";
import mongoose from "mongoose";
import Account from "../../models/AccountSchema.js";
import Order from "../../models/OrderSchema.js";

// Constants
const SYMBOL_MAPPING = {
  TTBAR: process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix",
  KGBAR: process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix",
};

const CONVERSION_FACTORS = {
  TTBAR: 13.7628,
  KGBAR: 32.1507 * 3.674,
};

const GRAMS_PER_BAR = {
  TTBAR: 117,
  KGBAR: 1000,
};

// Inline formatCurrency function
const formatCurrency = (amount) => {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount || 0);
};

// Utility functions
const generateEntryId = (prefix) => {
  const timestamp = Date.now().toString();
  const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp.substring(timestamp.length - 5)}-${randomStr}`;
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

    const availableBalance = parseFloat(account.reservedAmount) || 0;
    const tradeCost = calculateTradeCost(price, volumeValue, symbol);
    const marginRequirement = tradeCost * (account.margin / 100);

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

// Get live price message
export const getPriceMessageMT5 = async (
  symbol = "TTBAR",
  askSpread = 0,
  bidSpread = 0
) => {
  try {
    const marketData = await mt5MarketDataService.getMarketData(
      SYMBOL_MAPPING[symbol]
    );
    if (!marketData || !marketData.ask || !marketData.bid) {
      return "⚠️ Prices unavailable. Type MENU.";
    }

    const factor = CONVERSION_FACTORS[symbol];
    const unit = symbol;
    const adjustedAsk = marketData.ask * factor + askSpread;
    const adjustedBid = marketData.bid * factor - bidSpread;
    const spread = marketData.ask - marketData.bid;

    const timestamp = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Dubai",
      dateStyle: "short",
      timeStyle: "short",
    });

    return `📈 ${symbol} Prices 🚀\n🟢 Buy: AED ${adjustedAsk.toFixed(
      2
    )}/${unit}\n🔴 Sell: AED ${adjustedBid.toFixed(
      2
    )}/${unit}\n📊 Spread: ${spread.toFixed(
      1
    )} pips\n🕐 ${timestamp}\n\n💬 1=Buy, 2=Sell, MENU`;
  } catch (error) {
    console.error(`Error getting ${symbol} prices: ${error.message}`);
    return "❌ Prices error. Type MENU.";
  }
};

// Main menu message
export const getMainMenuMT5 = async (
  marketData,
  symbol = "TTBAR",
  userName = "",
  askSpread = 0,
  bidSpread = 0
) => {
  if (!marketData || !marketData.ask || !marketData.bid) {
    return `👋 ${
      userName || "Client"
    } 🌟\n\n🥇 ${symbol} Prices: Unavailable\n\n📋 Options:\n1 Buy\n2 Sell\n3 Balance\n4 Positions\n5 Prices\n\n💬 Type 1 or 'buy 1'`;
  }

  const factor = CONVERSION_FACTORS[symbol];
  const unit = symbol;

  const adjustedAsk = (marketData.ask + askSpread) * factor;
  const adjustedBid = (marketData.bid - bidSpread) * factor;

  return `👋 ${
    userName || "Client"
  } 🌟\n\n🥇 ${symbol} Prices:\n🟢 Buy: AED ${adjustedAsk.toFixed(
    2
  )}/${unit}\n🔴 Sell: AED ${adjustedBid.toFixed(
    2
  )}/${unit}\n\n📋 Options:\n1 Buy\n2 Sell\n3 Balance\n4 Positions\n5 Prices\n\n💬 Type 1 or 'buy 1'`;
};

// Positions message
export const getPositionsMessageMT5 = async (
  session,
  phoneNumber,
  symbol = "TTBAR"
) => {
  try {
    let positions = [];
    try {
      positions = await mt5Service.getPositions();
    } catch (mt5Error) {
      console.error(`MT5 getPositions error: ${mt5Error.message}`);
    }

    session.openPositions = positions || [];
    session.state = "VIEW_POSITIONS";
    updateUserSession(phoneNumber, session);

    if (!positions || !positions.length) {
      return `📋 Positions\nNo open positions.\n\n💬 Type MENU`;
    }

    const factor = CONVERSION_FACTORS[symbol];
    let totalPL = 0;
    let message = `📋 Open Positions 🏦\n\n`;

    positions.forEach((position, index) => {
      const profit = position.profit || 0;
      totalPL += profit;
      const plColor = profit >= 0 ? "🟢" : "🔴";
      const plSign = profit >= 0 ? "+" : "";
      const unit = symbol;
      const openPrice = (position.price_open * factor).toFixed(2);
      const currentPrice = (position.price_current * factor).toFixed(2);

      message += `${position.type === "BUY" ? "📈" : "📉"} ${
        index + 1
      }. ${symbol}\n🎫 #${position.ticket} | ${
        position.volume
      } ${unit}\n💵 Open: AED ${openPrice}\n📍 Current: AED ${currentPrice}\n${plColor} P&L: ${plSign}AED ${Math.abs(
        profit
      ).toFixed(2)}\n\n`;
    });

    const totalColor = totalPL >= 0 ? "🟢" : "🔴";
    const totalSign = totalPL >= 0 ? "+" : "";
    message += `${totalColor} Total P&L: ${totalSign}AED ${Math.abs(
      totalPL
    ).toFixed(2)}\n\n💬 Number to close or MENU`;

    return message;
  } catch (error) {
    console.error(`Error fetching positions: ${error.message}`);
    return `❌ Positions error. Type MENU.`;
  }
};

// Handler functions
export const handleMainMenuMT5 = async (
  input,
  session,
  phoneNumber,
  account,
  marketData,
  symbol = "TTBAR"
) => {
  const unit = symbol;
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

export const executeOrderDirectly = async (
  session,
  phoneNumber,
  account,
  marketData,
  symbol
) => {
  const { volume, type: orderType } = session.pendingOrder;
  const unit = symbol;
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
      if (!mt5Result.success || !mt5Result.price || !mt5Result.ticket) {
        throw new Error(mt5Result.error || "MT5 trade failed");
      }

      const actualExecutionPrice = parseFloat(mt5Result.price);
      const clientPricePerGram =
        (actualExecutionPrice +
          (orderType === "BUY" ? accountDoc.askSpread : -accountDoc.bidSpread)) *
        CONVERSION_FACTORS[symbol] *
        volume;

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

    const totalValue = calculateTradeCost(actualPrice, volume, symbol);
    return `🎉 ${orderType} ${volume} ${symbol} Executed! 🚀\n📌 Price: AED ${actualPrice.toFixed(
      2
    )}\n🎫 Ticket: #${ticket}\n\n💬 4=Positions | MENU`;
  } catch (error) {
    console.error(`Direct order error: ${error.message}`);
    session.state = "MAIN_MENU";
    session.pendingOrder = null;
    updateUserSession(phoneNumber, session);
    return `❌ ${error.message}\nType MENU.`;
  }
};

export const handleVolumeInputMT5 = async (
  input,
  session,
  phoneNumber,
  account,
  marketData,
  symbol
) => {
  const unit = symbol;
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
    return `❌ Invalid volume. >0 (e.g., 0.1)\n\n📈 ${typePrefix} ${symbol} at AED ${adjustedPrice}/${unit}\nVolume:`;
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
  const unit = symbol;

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

      const totalValue = calculateTradeCost(actualPrice, volume, symbol);
      return `🎉 ${orderType} ${volume} ${symbol} Executed! 🚀\n📌 Price: AED ${actualPrice.toFixed(
        2
      )}\n🎫 Ticket: #${ticket}\n\n💬 4=Positions | MENU`;
    } catch (error) {
      console.error(`Order confirmation error: ${error.message}`);
      session.state = "MAIN_MENU";
      session.pendingOrder = null;
      updateUserSession(phoneNumber, session);
      return `❌ ${error.message}\nType MENU.`;
    }
  }

  return `ℹ️ YES or MENU`;
};

export const handlePositionSelectionMT5 = async (
  input,
  session,
  phoneNumber
) => {
  const symbol = session.symbol || "TTBAR";
  const marketData = await mt5MarketDataService.getMarketData(
    SYMBOL_MAPPING[symbol]
  );
  const unit = symbol;

  if (input.toLowerCase() === "menu") {
    session.state = "MAIN_MENU";
    session.openPositions = null;
    updateUserSession(phoneNumber, session);
    return await getMainMenuMT5(
      marketData,
      symbol,
      session.userName,
      account.askSpread || 0,
      account.bidSpread || 0
    );
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

      const mt5Symbol = SYMBOL_MAPPING[symbol] || symbol;
      const validatedSymbol = await mt5Service.validateSymbol(mt5Symbol);

      const mt5CloseData = {
        ticket: selectedPosition.ticket,
        symbol: validatedSymbol,
        volume: parseFloat(selectedPosition.volume),
        type: selectedPosition.type === "BUY" ? "SELL" : "BUY",
        openingPrice: parseFloat(selectedPosition.price_open),
      };

      const closeResult = await mt5Service.closeTrade(mt5CloseData);

      if (!closeResult.success) {
        if (
          closeResult.error.includes("Position not found") ||
          closeResult.likelyClosed
        ) {
          const priceData = await mt5Service.getPrice(validatedSymbol);
          if (priceData && priceData.bid && priceData.ask) {
            const mt5ClosingPrice =
              selectedPosition.type === "BUY"
                ? parseFloat(priceData.bid)
                : parseFloat(priceData.ask);

            return {
              success: true,
              ticket: selectedPosition.ticket,
              closePrice: mt5ClosingPrice,
              profit: 0,
              symbol: validatedSymbol,
            };
          } else {
            throw new Error(
              "Unable to get closing price for already closed position"
            );
          }
        } else {
          throw new Error(closeResult.error);
        }
      }

      const grams = parseFloat(selectedPosition.volume) / GRAMS_PER_BAR[symbol];
      const mt5Price = parseFloat(closeResult.closePrice || closeResult.price);
      const closingPrice = mt5Price * CONVERSION_FACTORS[symbol] * grams;

      const updateData = {
        orderStatus: "CLOSED",
        closingPrice,
        closingDate: new Date(),
      };

      const updatedOrder = await updateTradeStatus(
        adminId,
        order._id.toString(),
        updateData,
        mongoSession
      );

      return {
        updatedOrder,
        closingPrice,
        openingPrice: parseFloat(order.openingPrice),
        profit: updatedOrder.profit.client,
      };
    });

    if (!result.success) throw new Error(result.error.message);

    const { updatedOrder, closingPrice, openingPrice, profit } = result.result;
    session.state = "MAIN_MENU";
    session.openPositions = null;
    updateUserSession(phoneNumber, session);

    const grams = selectedPosition.volume / GRAMS_PER_BAR[symbol];
    const openPricePerUnit = openingPrice / grams;
    const closePricePerUnit = closingPrice / grams;

    const profitEmoji = profit >= 0 ? "💰" : "📉";
    const profitText = profit >= 0 ? "Profit" : "Loss";
    const profitColor = profit >= 0 ? "+" : "";

    return `🎉 Position #${selectedPosition.ticket} Closed! ✅\n\n📊 *Trade Summary*\n━━━━━━━━━━━━━━━━\n📈 Open:  AED ${openPricePerUnit.toFixed(
      2
    )}/${unit}\n📉 Close: AED ${closePricePerUnit.toFixed(
      2
    )}/${unit}\n${profitEmoji} ${profitText}: ${profitColor}AED ${Math.abs(
      profit
    ).toFixed(2)}\n\n💰 Total: AED ${closingPrice.toFixed(
      2
    )}\n\n💬 4=Positions | MENU`;
  } catch (error) {
    console.error(
      `Position close error for ticket ${selectedPosition.ticket}: ${error.message}`
    );
    session.state = "MAIN_MENU";
    session.openPositions = null;
    updateUserSession(phoneNumber, session);
    return `❌ ${error.message}\nType MENU.`;
  }
};

// Process user input
export const processUserInputMT5 = async (
  message,
  session,
  twilioClient,
  from,
  twilioNumber,
  phoneNumber,
  account
) => {
  const input = message.trim().toLowerCase();
  console.log(
    `processUserInputMT5: input=${input}, state=${session.state}, phone=${phoneNumber}`
  );

  try {
    const symbol = session.symbol || "TTBAR";
    const marketData = await mt5MarketDataService.getMarketData(
      SYMBOL_MAPPING[symbol]
    );

    // Check market hours before processing trade-related inputs
    const marketStatus = await mt5Service.checkMarketHours(SYMBOL_MAPPING[symbol]);
    if (!marketStatus.isOpen && ["1", "2", "buy", "sell"].includes(input)) {
      return `⚠️ Market is closed. Please contact our support team at +971 58 502 3411 for assistance.\nType MENU.`;
    }

    const specialCommands = {
      menu: async () => {
        session.state = "MAIN_MENU";
        updateUserSession(phoneNumber, session);
        return await getMainMenuMT5(
          marketData,
          symbol,
          session.userName,
          account.askSpread || 0,
          account.bidSpread || 0
        );
      },
      price: async () =>
        await getPriceMessageMT5(
          symbol,
          account.askSpread || 0,
          account.bidSpread || 0
        ),
      prices: async () =>
        await getPriceMessageMT5(
          symbol,
          account.askSpread || 0,
          account.bidSpread || 0
        ),
      positions: async () =>
        await getPositionsMessageMT5(session, phoneNumber, symbol),
      balance: async () => {
        const balance = await getUserBalance(session.accountId, phoneNumber);
        return `💰 Balance 💸\nEquity: AED ${formatCurrency(
          account?.AMOUNTFC || balance.cash
        )}\nAvailable: AED ${formatCurrency(
          account?.reservedAmount || balance.cash
        )}\n\n💬 Type MENU`;
      },
      help: async () =>
        `📖 Help 🆘\nMENU: Menu\nPRICE: Prices\nBALANCE: Balance\nPOSITIONS: Trades\nbuy 1: Buy gold\nsell 1: Sell gold\n\n📞 Support: +971 58 502 3411\n💬 Type MENU`,
    };

    if (specialCommands[input]) {
      const message = await specialCommands[input]();
      return message;
    }

    let response;
    switch (session.state) {
      case "MAIN_MENU":
        response = await handleMainMenuMT5(
          input,
          session,
          phoneNumber,
          account,
          marketData,
          symbol
        );
        break;
      case "AWAITING_VOLUME":
        response = await handleVolumeInputMT5(
          input,
          session,
          phoneNumber,
          account,
          marketData,
          symbol
        );
        break;
      case "CONFIRM_ORDER":
        response = await handleOrderConfirmationMT5(
          input,
          session,
          phoneNumber,
          account
        );
        break;
      case "VIEW_POSITIONS":
        response = await handlePositionSelectionMT5(
          input,
          session,
          phoneNumber
        );
        break;
      default:
        session.state = "MAIN_MENU";
        updateUserSession(phoneNumber, session);
        response = await getMainMenuMT5(
          marketData,
          symbol,
          session.userName,
          account.askSpread || 0,
          account.bidSpread || 0
        );
    }

    return response;
  } catch (error) {
    console.error(`Input processing error: ${error.message}`);
    session.state = "MAIN_MENU";
    updateUserSession(phoneNumber, session);
    return `❌ ${error.message}\nType MENU.`;
  }
};