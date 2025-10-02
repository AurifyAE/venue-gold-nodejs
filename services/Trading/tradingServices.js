import mongoose from "mongoose";
import LPPosition from "../../models/LPPositionSchema.js";
import Order from "../../models/OrderSchema.js";
import Ledger from "../../models/LedgerSchema.js";
import Account from "../../models/AccountSchema.js";
import mt5Service from "../../services/Trading/mt5Service.js";
import LPProfit from "../../models/LPProfit.js";

const GRAMS_PER_BAR = {
  TTBAR: 117,
  KGBAR: 1000,
};

const CONVERSION_FACTORS = {
  TTBAR: 13.7628,
  KGBAR: 32.1507 * 3.674, // 118.00167218
};

const SYMBOL_ALIASES = {
  XAUUSD: "TTBAR",
  XAUUSD_KG: "KGBAR",
};

const SYMBOL_MAPPING = {
  TTBAR: process.env.MT5_SYMBOL || "XAUUSD.gm",
  KGBAR: process.env.MT5_SYMBOL || "XAUUSD.gm",
};

const generateEntryId = (prefix) => {
  const timestamp = Date.now().toString();
  const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp.substring(timestamp.length - 5)}-${randomStr}`;
};

const validateOrderData = (tradeData, userId, adminId) => {
  const errors = [];

  if (!tradeData.orderNo || typeof tradeData.orderNo !== "string") {
    errors.push("Invalid or missing orderNo");
  }
  if (!["BUY", "SELL"].includes(tradeData.type)) {
    errors.push("Invalid type: must be BUY or SELL");
  }
  if (isNaN(tradeData.volume) || tradeData.volume <= 0) {
    errors.push("Invalid volume: must be a positive number");
  }
  const crmSymbol = tradeData.symbol;
  if (!crmSymbol || !SYMBOL_MAPPING[crmSymbol] || !GRAMS_PER_BAR[crmSymbol]) {
    errors.push(
      `Invalid symbol: ${tradeData.symbol}. Supported: ${Object.keys(
        SYMBOL_MAPPING
      ).join(", ")}`
    );
  }
  tradeData.symbol = crmSymbol;

  const price = parseFloat(tradeData.openingPrice ?? tradeData.price);
  if (isNaN(price) || price <= 0) {
    errors.push("Invalid price or openingPrice: must be a positive number");
  }
  if (isNaN(tradeData.requiredMargin) || tradeData.requiredMargin <= 0) {
    errors.push("Invalid requiredMargin: must be a positive number");
  }
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    errors.push("Invalid userId");
  }
  if (!mongoose.Types.ObjectId.isValid(adminId)) {
    errors.push("Invalid adminId");
  }
  if (
    !tradeData.openingDate ||
    isNaN(new Date(tradeData.openingDate).getTime())
  ) {
    errors.push("Invalid or missing openingDate");
  }

  return errors.length ? errors.join("; ") : null;
};

export const createTrade = async (
  adminId,
  userId,
  tradeData,
  session = null
) => {
  console.log("createTrade", { adminId, userId, tradeData });
  const mongoSession = session || (await mongoose.startSession());
  let committed = false;
  let sessionEnded = false;

  // Initialize finalClientOpeningPrice to avoid undefined reference
  let finalClientOpeningPrice = null;

  try {
    if (!session) mongoSession.startTransaction();

    // Validate trade data
    const validationError = validateOrderData(tradeData, userId, adminId);
    if (validationError) {
      throw new Error(`Order validation failed: ${validationError}`);
    }

    // Validate user account
    const userAccount = await Account.findById(userId).session(mongoSession);
    if (!userAccount) {
      throw new Error("User account not found");
    }

    const currentCashBalance = parseFloat(userAccount.reservedAmount);
    const currentMetalBalance = parseFloat(userAccount.METAL_WT);
    const volume = parseFloat(tradeData.volume);
    const symbol = tradeData.symbol;
    const requiredMargin = parseFloat(tradeData.requiredMargin || 0);

    if (currentCashBalance < requiredMargin) {
      throw new Error("Insufficient cash balance");
    }

    // Calculate grams
    const grams = volume / GRAMS_PER_BAR[symbol];

    // Get spreads
    const askSpread = parseFloat(userAccount.askSpread) || 0;
    const bidSpread = parseFloat(userAccount.bidSpread) || 0;

    // Initial client price (AED, includes spread)
    let currentPrice = parseFloat(tradeData.openingPrice);
    currentPrice = currentPrice / grams; // Convert to AED per gram
    console.log(currentPrice);
    // Calculate MT5 base price (USD per oz, without spread)
    let mt5BasePrice =
      symbol === "TTBAR"
        ? currentPrice / CONVERSION_FACTORS.TTBAR
        : currentPrice / CONVERSION_FACTORS.KGBAR;

    let clientBasePrice = mt5BasePrice;

    console.log("clientBasePrice", clientBasePrice);

    // Calculate client order price (already includes spread)
    let clientOrderPrice =
      tradeData.type === "BUY"
        ? clientBasePrice - askSpread
        : clientBasePrice + bidSpread;

        console.log("clientOrderPrice" , clientOrderPrice);
        
    // Calculate LP price (MT5 price with spread adjustment)
    let lpCurrentPrice = clientOrderPrice;

    // Calculate gold weight value (client perspective, AED)
    const goldWeightValue =
      symbol === "TTBAR"
        ? clientBasePrice * CONVERSION_FACTORS.TTBAR * grams
        : clientBasePrice * CONVERSION_FACTORS.KGBAR * grams;

        console.log("goldWeightValue" , goldWeightValue )
    // Calculate LP gold weight value (LP perspective, AED)
    const lpGoldWeightValue =
      symbol === "TTBAR"
        ? lpCurrentPrice * CONVERSION_FACTORS.TTBAR * grams
        : lpCurrentPrice * CONVERSION_FACTORS.KGBAR * grams;

    // Calculate LP Profit
    const spread = tradeData.type === "BUY" ? askSpread : bidSpread;
    const gramValue = CONVERSION_FACTORS[symbol];
    const lpProfitValue = (gramValue * grams * spread).toFixed(2);

    // Set fallback for finalClientOpeningPrice
    finalClientOpeningPrice = goldWeightValue;

    // Create order
    const newOrder = new Order({
      orderNo: tradeData.orderNo,
      type: tradeData.type,
      volume: volume,
      symbol: symbol,
      requiredMargin: requiredMargin,
      price: goldWeightValue.toFixed(2),
      openingPrice: goldWeightValue.toFixed(2),
      profit: 0,
      user: userId,
      adminId: adminId,
      orderStatus: "OPEN",
      openingDate: new Date(tradeData.openingDate),
      storedTime: new Date(),
      comment: tradeData.comment || `Ord-${tradeData.orderNo}`,
      ticket: tradeData.ticket || null,
      lpPositionId: null,
      stopLoss: tradeData.stopLoss || 0,
      takeProfit: tradeData.takeProfit || 0,
      isTradeSafe: tradeData.takeProfit || tradeData.stopLoss ? true : false,
    });

    const savedOrder = await newOrder.save({ session: mongoSession });

    // Create LP position
    const lpPosition = new LPPosition({
      positionId: tradeData.orderNo,
      type: tradeData.type,
      profit: 0,
      volume: volume,
      adminId: adminId,
      symbol: symbol,
      entryPrice: lpGoldWeightValue.toFixed(2),
      openDate: new Date(tradeData.openingDate),
      currentPrice: lpGoldWeightValue.toFixed(2),
      clientOrders: savedOrder._id,
      status: "OPEN",
    });
    const savedLPPosition = await lpPosition.save({ session: mongoSession });

    // Create LP Profit entry
    const lpProfit = new LPProfit({
      orderNo: tradeData.orderNo,
      orderType: tradeData.type,
      status: "OPEN",
      volume: volume,
      value: lpProfitValue,
      user: userId,
      datetime: new Date(tradeData.openingDate),
    });
    const savedLPProfit = await lpProfit.save({ session: mongoSession });

    savedOrder.lpPositionId = savedLPPosition._id;
    await savedOrder.save({ session: mongoSession });

    // Update account balances
    let newCashBalance = currentCashBalance - requiredMargin;
    let newMetalBalance = currentMetalBalance;

    if (tradeData.type === "BUY") {
      newMetalBalance = currentMetalBalance + grams;
    } else if (tradeData.type === "SELL") {
      newMetalBalance = currentMetalBalance - grams;
    }

    await Account.findByIdAndUpdate(
      userId,
      {
        reservedAmount: newCashBalance.toFixed(2),
        METAL_WT: newMetalBalance.toFixed(2),
      },
      { session: mongoSession, new: true }
    );

    // Create ledger entries
    const orderLedgerEntry = new Ledger({
      entryId: generateEntryId("ORD"),
      entryType: "ORDER",
      referenceNumber: tradeData.orderNo,
      description: `Margin for ${
        tradeData.type
      } ${volume} ${symbol} @ ${clientOrderPrice.toFixed(
        2
      )} (AED ${goldWeightValue.toFixed(2)})`,
      amount: requiredMargin.toFixed(2),
      entryNature: "DEBIT",
      runningBalance: newCashBalance.toFixed(2),
      orderDetails: {
        type: tradeData.type,
        symbol: symbol,
        volume: volume,
        entryPrice: clientOrderPrice,
        profit: 0,
        status: "PROCESSING",
      },
      user: userId,
      adminId: adminId,
      date: new Date(tradeData.openingDate),
    });
    const savedOrderLedger = await orderLedgerEntry.save({
      session: mongoSession,
    });

    const lpLedgerEntry = new Ledger({
      entryId: generateEntryId("LP"),
      entryType: "LP_POSITION",
      referenceNumber: tradeData.orderNo,
      description: `LP Position opened for ${
        tradeData.type
      } ${volume} ${symbol} @ ${lpCurrentPrice.toFixed(
        2
      )} (AED ${lpGoldWeightValue.toFixed(2)})`,
      amount: lpGoldWeightValue.toFixed(2),
      entryNature: "CREDIT",
      runningBalance: newCashBalance.toFixed(2),
      lpDetails: {
        positionId: tradeData.orderNo,
        type: tradeData.type,
        symbol: symbol,
        volume: volume,
        entryPrice: lpCurrentPrice,
        profit: 0,
        status: "OPEN",
      },
      user: userId,
      adminId: adminId,
      date: new Date(tradeData.openingDate),
    });
    const savedLPLedger = await lpLedgerEntry.save({ session: mongoSession });

    const cashTransactionLedgerEntry = new Ledger({
      entryId: generateEntryId("TRX"),
      entryType: "TRANSACTION",
      referenceNumber: tradeData.orderNo,
      description: `Margin allocation for trade ${tradeData.orderNo}`,
      amount: requiredMargin.toFixed(2),
      entryNature: "DEBIT",
      runningBalance: newCashBalance.toFixed(2),
      transactionDetails: {
        type: null,
        asset: "CASH",
        previousBalance: currentCashBalance,
      },
      user: userId,
      adminId: adminId,
      date: new Date(tradeData.openingDate),
      notes: `Cash margin allocated for ${tradeData.type} order on ${symbol}`,
    });
    const savedCashLedger = await cashTransactionLedgerEntry.save({
      session: mongoSession,
    });

    // MT5 Integration
    let mt5Result = null;
    let finalLPPrice = lpGoldWeightValue;
    let updatedLPProfitValue = lpProfitValue;

 
    if (!session) {
      await mongoSession.commitTransaction();
      committed = true;
      mongoSession.endSession();
      sessionEnded = true;
    }

    return {
      clientOrder: {
        ...savedOrder.toObject(),
        price: finalClientOpeningPrice.toFixed(2),
        openingPrice: finalClientOpeningPrice.toFixed(2),
        orderStatus: mt5Result
          ? "OPEN"
          : tradeData.ticket
          ? "OPEN"
          : "PROCESSING",
        ticket:
          mt5Result?.ticket?.toString() || tradeData.ticket?.toString() || null,
      },
      lpPosition: {
        ...savedLPPosition.toObject(),
        entryPrice: finalLPPrice.toFixed(2),
        currentPrice: finalLPPrice.toFixed(2),
      },
      lpProfit: {
        ...savedLPProfit.toObject(),
        value: updatedLPProfitValue,
      },
      mt5Trade: mt5Result
        ? {
            ticket: mt5Result.ticket,
            volume: mt5Result.volume,
            price: mt5Result.price,
            symbol: mt5Result.symbol || symbol,
            type: tradeData.type,
          }
        : null,
      balances: {
        cash: newCashBalance,
        gold: newMetalBalance,
      },
      requiredMargin,
      goldWeightValue: finalClientOpeningPrice,
      lpProfitValue: updatedLPProfitValue,
      convertedPrice: {
        client: (finalClientOpeningPrice / grams).toFixed(2),
        lp: (finalLPPrice / grams).toFixed(2),
      },
      priceDetails: {
        mt5ExecutionPrice: mt5Result ? mt5Result.price : mt5BasePrice,
        clientOpeningPrice: (finalClientOpeningPrice / grams).toFixed(2),
        lpPrice: (finalLPPrice / grams).toFixed(2),
        spreadApplied: spread,
      },
    };
  } catch (error) {
    if (!committed && !session) {
      try {
        await mongoSession.abortTransaction();
      } catch (abortError) {
        console.error(`Failed to abort transaction: ${abortError.message}`);
      }
    }
    console.error(
      `Trade creation error: ${error.message}, Stack: ${error.stack}`
    );
    throw new Error(`Error creating trade: ${error.message}`);
  } finally {
    if (!session && !sessionEnded) {
      try {
        mongoSession.endSession();
      } catch (endError) {
        console.error(`Failed to end session: ${endError.message}`);
      }
    }
  }
};

  export const updateTradeStatus = async (
    adminId,
    orderId,
    updateData,
    session = null
  ) => {
    const mongoSession = session || (await mongoose.startSession());
    let committed = false;
    let sessionEnded = false;

    try {
      if (!session) mongoSession.startTransaction();

      const allowedUpdates = [
        "orderStatus",
        "closingPrice",
        "closingDate",
        "profit",
        "comment",
        "price",
        "ticket",
        "volume",
        "symbol",
        "notificationError",
        "AMOUNTFC",
      ];
      const sanitizedData = {};
      Object.keys(updateData).forEach((key) => {
        if (allowedUpdates.includes(key)) {
          sanitizedData[key] = updateData[key];
        }
      });

      if (sanitizedData.orderStatus === "CLOSED" && !sanitizedData.closingDate) {
        sanitizedData.closingDate = new Date();
      }
      if (sanitizedData.closingPrice) {
        sanitizedData.price = sanitizedData.closingPrice;
      }

      const order = await Order.findOne({ _id: orderId, adminId }).session(
        mongoSession
      );
      if (!order) {
        throw new Error("Order not found or unauthorized");
      }

      const userAccount = await Account.findById(order.user).session(
        mongoSession
      );
      if (!userAccount) {
        throw new Error("User account not found");
      }

      const askSpread = parseFloat(userAccount.askSpread) || 0;
      const bidSpread = parseFloat(userAccount.bidSpread) || 0;

      let mt5ClosingPrice = null; // USD per oz
      let clientClosingPrice = null; // AED for total grams

      if (
        sanitizedData.orderStatus === "CLOSED" &&
        order.orderStatus !== "CLOSED"
      ) {
        try {
          const mt5Symbol = SYMBOL_MAPPING[order.symbol] || order.symbol;
          const validatedSymbol = await mt5Service.validateSymbol(mt5Symbol);

          const mt5CloseData = {
            ticket: order.ticket,
            symbol: validatedSymbol,
            volume: parseFloat(order.volume),
            type: order.type === "BUY" ? "SELL" : "BUY",
            openingPrice: parseFloat(order.price),
          };

          const mt5CloseResult = await mt5Service.closeTrade(mt5CloseData);

          if (!mt5CloseResult.success) {
            if (
              mt5CloseResult.error.includes("Position not found") ||
              mt5CloseResult.likelyClosed
            ) {
              const priceData = await mt5Service.getPrice(validatedSymbol);
              if (priceData && priceData.bid && priceData.ask) {
                mt5ClosingPrice =
                  order.type === "BUY"
                    ? parseFloat(priceData.bid)
                    : parseFloat(priceData.ask);
              } else {
                mt5ClosingPrice =
                  parseFloat(order.openingPrice) / GRAMS_PER_BAR[order.symbol];
              }
            } else {
              throw new Error(
                `MT5 trade closure failed: ${mt5CloseResult.error}`
              );
            }
          } else {
            mt5ClosingPrice = parseFloat(
              mt5CloseResult.closePrice || mt5CloseResult.data?.price
            );
          }

          // Calculate client closing price
          const grams = order.volume / GRAMS_PER_BAR[order.symbol];
          let clientUSDPerOz =
            order.type === "BUY"
              ? mt5ClosingPrice - bidSpread
              : mt5ClosingPrice + askSpread;
          clientClosingPrice =
            order.symbol === "TTBAR"
              ? clientUSDPerOz * CONVERSION_FACTORS.TTBAR * grams
              : clientUSDPerOz * CONVERSION_FACTORS.KGBAR * grams;

          sanitizedData.closingPrice = clientClosingPrice.toFixed(2);
          sanitizedData.price = clientClosingPrice.toFixed(2);
        } catch (mt5Error) {
          console.error(`Failed to close MT5 trade: ${mt5Error.message}`);
          if (
            mt5Error.message.includes("Position not found") ||
            mt5Error.message.includes("Request failed with status code 400")
          ) {
            const priceData = await mt5Service.getPrice(
              SYMBOL_MAPPING[order.symbol] || order.symbol
            );
            if (priceData && priceData.bid && priceData.ask) {
              mt5ClosingPrice =
                order.type === "BUY"
                  ? parseFloat(priceData.bid)
                  : parseFloat(priceData.ask);
              const grams = order.volume / GRAMS_PER_BAR[order.symbol];
              let clientUSDPerOz =
                order.type === "BUY"
                  ? mt5ClosingPrice - bidSpread
                  : mt5ClosingPrice + askSpread;
              clientClosingPrice =
                order.symbol === "TTBAR"
                  ? clientUSDPerOz * CONVERSION_FACTORS.TTBAR * grams
                  : clientUSDPerOz * CONVERSION_FACTORS.KGBAR * grams;
              sanitizedData.closingPrice = clientClosingPrice.toFixed(2);
              sanitizedData.price = clientClosingPrice.toFixed(2);
            } else {
              mt5ClosingPrice =
                parseFloat(order.openingPrice) / GRAMS_PER_BAR[order.symbol];
              clientClosingPrice = parseFloat(order.openingPrice);
              sanitizedData.closingPrice = clientClosingPrice.toFixed(2);
              sanitizedData.price = clientClosingPrice.toFixed(2);
            }
          } else {
            throw mt5Error;
          }
        }
      }

      if (!clientClosingPrice && sanitizedData.closingPrice) {
        clientClosingPrice = parseFloat(sanitizedData.closingPrice);
      }

      let clientProfit = 0;
      if (clientClosingPrice) {
        const entryGoldWeightValue = parseFloat(order.openingPrice);
        const closingGoldWeightValue = clientClosingPrice;
        clientProfit =
          order.type === "BUY"
            ? closingGoldWeightValue - entryGoldWeightValue
            : entryGoldWeightValue - closingGoldWeightValue;
      }

      let newCashBalance = parseFloat(userAccount.reservedAmount);
      let newMetalBalance = parseFloat(userAccount.METAL_WT);
      let newAMOUNTFC = parseFloat(userAccount.AMOUNTFC || 0);
      const currentCashBalance = newCashBalance;
      const currentMetalBalance = newMetalBalance;
      const currentAMOUNTFC = newAMOUNTFC;

      Object.keys(sanitizedData).forEach((key) => {
        order[key] = sanitizedData[key];
      });

      if (sanitizedData.orderStatus === "CLOSED") {
        order.profit = clientProfit.toFixed(2);
      }

      await order.save({ session: mongoSession });

      let lpProfit = 0;
      const lpPosition = await LPPosition.findOne({
        positionId: order.orderNo,
      }).session(mongoSession);

      if (lpPosition) {
        let lpClosingPrice = null;
        const grams = order.volume / GRAMS_PER_BAR[order.symbol];
        if (mt5ClosingPrice !== null) {
          lpClosingPrice =
            order.symbol === "TTBAR"
              ? mt5ClosingPrice * CONVERSION_FACTORS.TTBAR * grams
              : mt5ClosingPrice * CONVERSION_FACTORS.KGBAR * grams;
          lpPosition.closingPrice = lpClosingPrice.toFixed(2);
          lpPosition.currentPrice = lpClosingPrice.toFixed(2);
        } else if (sanitizedData.closingPrice) {
          lpClosingPrice = parseFloat(sanitizedData.closingPrice);
          lpPosition.closingPrice = lpClosingPrice.toFixed(2);
          lpPosition.currentPrice = lpClosingPrice.toFixed(2);
        }

        if (sanitizedData.closingDate) {
          lpPosition.closeDate = sanitizedData.closingDate;
        }

        if (sanitizedData.orderStatus === "CLOSED") {
          lpPosition.status = "CLOSED";

          const lpEntryGoldWeightValue = parseFloat(lpPosition.entryPrice);
          const lpClosingGoldWeightValue =
            lpClosingPrice || parseFloat(sanitizedData.closingPrice);
          const entryGoldWeightValue = parseFloat(order.openingPrice);
          const closingGoldWeightValue = clientClosingPrice;

          const openingDifference = Math.abs(
            lpEntryGoldWeightValue - entryGoldWeightValue
          );
          const closingDifference = Math.abs(
            lpClosingGoldWeightValue - closingGoldWeightValue
          );
          lpProfit = openingDifference + closingDifference;

          lpPosition.profit = lpProfit.toFixed(2);
        }

        await lpPosition.save({ session: mongoSession });
      }

      if (sanitizedData.orderStatus === "CLOSED") {
        const lpProfitRecord = await LPProfit.findOne({
          orderNo: order.orderNo,
          status: "OPEN",
        }).session(mongoSession);

        if (lpProfitRecord) {
          const gramValue = CONVERSION_FACTORS[order.symbol];
          const grams = order.volume / GRAMS_PER_BAR[order.symbol];
          const closingLPProfitValue =
            order.type === "BUY"
              ? gramValue * grams * bidSpread
              : gramValue * grams * askSpread;

          const totalLPProfit =
            parseFloat(lpProfitRecord.value) + closingLPProfitValue;
          lpProfitRecord.status = "CLOSED";
          lpProfitRecord.value = totalLPProfit.toFixed(2);
          lpProfitRecord.datetime = new Date(sanitizedData.closingDate);

          await lpProfitRecord.save({ session: mongoSession });
        }
      }

      if (sanitizedData.orderStatus === "CLOSED") {
        const settlementAmount = parseFloat(order.requiredMargin || 0);
        const userProfit = clientProfit > 0 ? clientProfit : 0;

        if (order.type === "BUY") {
          newCashBalance = currentCashBalance + settlementAmount + clientProfit;
          newAMOUNTFC = currentAMOUNTFC + clientProfit;
          newMetalBalance =
            currentMetalBalance - order.volume / GRAMS_PER_BAR[order.symbol];
        } else if (order.type === "SELL") {
          newCashBalance = currentCashBalance + settlementAmount + clientProfit;
          newAMOUNTFC = currentAMOUNTFC + clientProfit;
          newMetalBalance =
            currentMetalBalance + order.volume / GRAMS_PER_BAR[order.symbol];
        }

        await Account.findByIdAndUpdate(
          order.user,
          {
            reservedAmount: newCashBalance.toFixed(2),
            METAL_WT: newMetalBalance.toFixed(2),
            AMOUNTFC: newAMOUNTFC.toFixed(2),
          },
          { session: mongoSession, new: true }
        );

        const orderLedgerEntry = new Ledger({
          entryId: generateEntryId("ORD"),
          entryType: "ORDER",
          referenceNumber: order.orderNo,
          description: `Closing ${order.type} ${order.volume} ${
            order.symbol
          } @ ${(
            clientClosingPrice /
            (order.volume / GRAMS_PER_BAR[order.symbol])
          ).toFixed(2)}${userProfit > 0 ? " with profit" : ""}`,
          amount: (settlementAmount + userProfit).toFixed(2),
          entryNature: "CREDIT",
          runningBalance: newCashBalance.toFixed(2),
          orderDetails: {
            type: order.type,
            symbol: order.symbol,
            volume: order.volume,
            entryPrice:
              parseFloat(order.openingPrice) /
              (order.volume / GRAMS_PER_BAR[order.symbol]),
            closingPrice:
              clientClosingPrice / (order.volume / GRAMS_PER_BAR[order.symbol]),
            profit: clientProfit.toFixed(2),
            status: "CLOSED",
          },
          user: order.user,
          adminId: adminId,
          date: new Date(sanitizedData.closingDate),
        });
        await orderLedgerEntry.save({ session: mongoSession });

        if (lpPosition) {
          const lpClosingPrice = mt5ClosingPrice
            ? (order.symbol === "TTBAR"
                ? mt5ClosingPrice * CONVERSION_FACTORS.TTBAR
                : mt5ClosingPrice * CONVERSION_FACTORS.KGBAR) *
              (order.volume / GRAMS_PER_BAR[order.symbol])
            : clientClosingPrice;

          const lpLedgerEntry = new Ledger({
            entryId: generateEntryId("LP"),
            entryType: "LP_POSITION",
            referenceNumber: order.orderNo,
            description: `LP Position closed for ${order.type} ${order.volume} ${
              order.symbol
            } @ ${(
              lpClosingPrice /
              (order.volume / GRAMS_PER_BAR[order.symbol])
            ).toFixed(2)}`,
            amount: settlementAmount.toFixed(2),
            entryNature: "DEBIT",
            runningBalance: newCashBalance.toFixed(2),
            lpDetails: {
              positionId: order.orderNo,
              type: order.type,
              symbol: order.symbol,
              volume: order.volume,
              entryPrice:
                parseFloat(lpPosition.entryPrice) /
                (order.volume / GRAMS_PER_BAR[order.symbol]),
              closingPrice:
                lpClosingPrice / (order.volume / GRAMS_PER_BAR[order.symbol]),
              profit: lpProfit.toFixed(2),
              status: "CLOSED",
            },
            user: order.user,
            adminId: adminId,
            date: new Date(sanitizedData.closingDate),
          });
          await lpLedgerEntry.save({ session: mongoSession });
        }

        const cashTransactionLedgerEntry = new Ledger({
          entryId: generateEntryId("TRX"),
          entryType: "TRANSACTION",
          referenceNumber: order.orderNo,
          description: `Cash settlement for closing trade ${order.orderNo}`,
          amount: settlementAmount.toFixed(2),
          entryNature: "CREDIT",
          runningBalance: newCashBalance.toFixed(2),
          transactionDetails: {
            type: null,
            asset: "CASH",
            previousBalance: currentCashBalance,
          },
          user: order.user,
          adminId: adminId,
          date: new Date(sanitizedData.closingDate),
          notes: `Cash settlement for closed ${order.type} order on ${order.symbol}`,
        });
        await cashTransactionLedgerEntry.save({ session: mongoSession });

        const amountFCLedgerEntry = new Ledger({
          entryId: generateEntryId("TRX"),
          entryType: "TRANSACTION",
          referenceNumber: order.orderNo,
          description: `AMOUNTFC ${
            clientProfit >= 0 ? "profit" : "loss"
          } for closing trade ${order.orderNo}`,
          amount: Math.abs(clientProfit).toFixed(2),
          entryNature: clientProfit >= 0 ? "CREDIT" : "DEBIT",
          runningBalance: newAMOUNTFC.toFixed(2),
          transactionDetails: {
            type: null,
            asset: "CASH",
            previousBalance: currentAMOUNTFC,
          },
          user: order.user,
          adminId: adminId,
          date: new Date(sanitizedData.closingDate),
          notes: `AMOUNTFC updated with ${
            clientProfit >= 0 ? "profit" : "loss"
          } from closed ${order.type} order`,
        });
        await amountFCLedgerEntry.save({ session: mongoSession });
      }

      if (!session) {
        await mongoSession.commitTransaction();
        committed = true;
        mongoSession.endSession();
        sessionEnded = true;
      }

      return {
        order,
        balances: {
          cash: newCashBalance,
          gold: newMetalBalance,
          AMOUNTFC: newAMOUNTFC,
        },
        profit: {
          client: clientProfit,
          lp: lpPosition ? parseFloat(lpPosition.profit) : 0,
        },
        closingPrices: {
          mt5ClosingPrice: mt5ClosingPrice,
          clientClosingPrice: clientClosingPrice,
          spreadApplied: order.type === "BUY" ? bidSpread : askSpread,
        },
      };
    } catch (error) {
      if (!committed && !session) {
        try {
          await mongoSession.abortTransaction();
        } catch (abortError) {
          console.error(
            `Failed to abort transaction for orderId ${orderId}: ${abortError.message}`
          );
        }
      }
      console.error(
        `Trade update error for orderId ${orderId}: ${error.message}, Stack: ${error.stack}`
      );
      throw new Error(`Error updating trade: ${error.message}`);
    } finally {
      if (!session && !sessionEnded) {
        try {
          mongoSession.endSession();
        } catch (endError) {
          console.error(
            `Failed to end session for orderId ${orderId}: ${endError.message}`
          );
        }
      }
    }
  };
