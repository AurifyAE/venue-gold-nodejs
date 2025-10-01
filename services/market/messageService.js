import mt5MarketDataService from "../../services/Trading/mt5MarketDataService.js";
import mt5Service from "../../services/Trading/mt5Service.js";
import { getUserBalance } from "../../services/market/balanceService.js";
import { updateUserSession } from "../../services/market/sessionService.js";
import {
  handleMainMenuMT5,
  handleVolumeInputMT5,
  handleOrderConfirmationMT5,
  handlePositionSelectionMT5,
  formatCurrency,
} from "../../controllers/chat/whatsappController.js";

// Constants
const SYMBOL_MAPPING = {
  TTBAR: process.env.MT5_SYMBOL || "XAUUSD.gm",
  KGBAR: process.env.MT5_SYMBOL || "XAUUSD.gm",
};

const CONVERSION_FACTORS = {
  TTBAR: 13.7628,
  KGBAR: 32.1507 * 3.674,
};

const GRAMS_PER_BAR = {
  TTBAR: 117,
  KGBAR: 1000,
};

// Get live price message
export const getPriceMessageMT5 = async (symbol = "TTBAR", askSpread = 0, bidSpread = 0) => {
  try {
    const marketData = await mt5MarketDataService.getMarketData(SYMBOL_MAPPING[symbol]);
    if (!marketData || !marketData.ask || !marketData.bid) {
      return "⚠️ Prices unavailable. Type MENU.";
    }

    const factor = CONVERSION_FACTORS[symbol];
    const unit = symbol === "KGBAR" ? "KG" : "GRAM";
    const adjustedAsk = (marketData.ask * factor) + askSpread;
    const adjustedBid = (marketData.bid * factor) - bidSpread;
    const spread = (marketData.ask - marketData.bid) ;

    const timestamp = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Dubai",
      dateStyle: "short",
      timeStyle: "short",
    });

    return `📈 ${symbol} Prices 🚀\n🟢 Buy: AED ${adjustedAsk.toFixed(2)}/${unit}\n🔴 Sell: AED ${adjustedBid.toFixed(2)}/${unit}\n📊 Spread: ${spread.toFixed(1)} pips\n🕐 ${timestamp}\n\n💬 1=Buy, 2=Sell, MENU`;
  } catch (error) {
    console.error(`Error getting ${symbol} prices: ${error.message}`);
    return "❌ Prices error. Type MENU.";
  }
};

// Main menu message
export const getMainMenuMT5 = async (marketData, symbol = "TTBAR", userName = "", askSpread = 0, bidSpread = 0) => {
  if (!marketData || !marketData.ask || !marketData.bid) {
    return `👋 ${userName || "Client"} 🌟\n\n🥇 ${symbol} Prices: Unavailable\n\n📋 Options:\n1 Buy\n2 Sell\n3 Balance\n4 Positions\n5 Prices\n\n💬 Type 1 or 'buy 1'`;
  }

  const factor = CONVERSION_FACTORS[symbol];
  const unit = symbol === "KGBAR" ? "KG" : "GRAM";
  const adjustedAsk = (marketData.ask * factor) + askSpread;
  const adjustedBid = (marketData.bid * factor) - bidSpread;

  return `👋 ${userName || "Client"} 🌟\n\n🥇 ${symbol} Prices:\n🟢 Buy: AED ${adjustedAsk.toFixed(2)}/${unit}\n🔴 Sell: AED ${adjustedBid.toFixed(2)}/${unit}\n\n📋 Options:\n1 Buy\n2 Sell\n3 Balance\n4 Positions\n5 Prices\n\n💬 Type 1 or 'buy 1'`;
};

// Positions message
export const getPositionsMessageMT5 = async (session, phoneNumber, symbol = "TTBAR") => {
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
      const unit = symbol === "KGBAR" ? "KG" : "GRAM";
      const openPrice = (position.price_open * factor).toFixed(2);
      const currentPrice = (position.price_current * factor).toFixed(2);

      message += `${position.type === "BUY" ? "📈" : "📉"} ${index + 1}. ${symbol}\n🎫 #${position.ticket} | ${position.volume} ${unit}\n💵 Open: AED ${openPrice}\n📍 Current: AED ${currentPrice}\n${plColor} P&L: ${plSign}AED ${Math.abs(profit).toFixed(2)}\n\n`;
    });

    const totalColor = totalPL >= 0 ? "🟢" : "🔴";
    const totalSign = totalPL >= 0 ? "+" : "";
    message += `${totalColor} Total P&L: ${totalSign}AED ${Math.abs(totalPL).toFixed(2)}\n\n💬 Number to close or MENU`;

    return message;
  } catch (error) {
    console.error(`Error fetching positions: ${error.message}`);
    return `❌ Positions error. Type MENU.`;
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
    const marketData = await mt5MarketDataService.getMarketData(SYMBOL_MAPPING[symbol]);

    const specialCommands = {
      menu: async () => {
        session.state = "MAIN_MENU";
        updateUserSession(phoneNumber, session);
        return await getMainMenuMT5(marketData, symbol, session.userName, account.askSpread || 0, account.bidSpread || 0);
      },
      price: async () => await getPriceMessageMT5(symbol, account.askSpread || 0, account.bidSpread || 0),
      prices: async () => await getPriceMessageMT5(symbol, account.askSpread || 0, account.bidSpread || 0),
      positions: async () => await getPositionsMessageMT5(session, phoneNumber, symbol),
      balance: async () => {
        const balance = await getUserBalance(session.accountId, phoneNumber);
        return `💰 Balance 💸\nEquity: AED ${formatCurrency(account?.AMOUNTFC || balance.cash)}\nAvailable: AED ${formatCurrency(account?.reservedAmount || balance.cash)}\n\n💬 MENU`;
      },
      help: async () => `📖 Help 🆘\nMENU: Menu\nPRICE: Prices\nBALANCE: Balance\nPOSITIONS: Trades\nbuy 1: Buy gold\nsell 1: Sell gold\n\n📞 Support: +971 58 502 3411\n💬 MENU`,
    };

    if (specialCommands[input]) {
      return await specialCommands[input]();
    }

    switch (session.state) {
      case "MAIN_MENU":
        return await handleMainMenuMT5(input, session, phoneNumber, account, marketData, symbol);
      case "AWAITING_VOLUME":
        return await handleVolumeInputMT5(input, session, phoneNumber, account, marketData, symbol);
      case "CONFIRM_ORDER":
        return await handleOrderConfirmationMT5(input, session, phoneNumber, account);
      case "VIEW_POSITIONS":
        return await handlePositionSelectionMT5(input, session, phoneNumber);
      default:
        session.state = "MAIN_MENU";
        updateUserSession(phoneNumber, session);
        return await getMainMenuMT5(marketData, symbol, session.userName, account.askSpread || 0, account.bidSpread || 0);
    }
  } catch (error) {
    console.error(`Input processing error: ${error.message}`);
    session.state = "MAIN_MENU";
    updateUserSession(phoneNumber, session);
    return `❌ Error: ${error.message}\nType MENU.`;
  }
};