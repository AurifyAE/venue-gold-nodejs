import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
const BASE_URL = "https://venuemt5.aurify.ae"; // Your Python API URL

class MT5Service {
  constructor() {
    this.isConnected = false;
    this.priceData = new Map();
    this.lastPriceUpdate = new Map();
  }

  async connect() {
    try {
      const response = await axios.post(`${BASE_URL}/connect`, {
        server: process.env.MT5_SERVER,
        login: parseInt(process.env.MT5_LOGIN),
        password: process.env.MT5_PASSWORD,
      });
      this.isConnected = response.data.success;
      return response.data.data;
    } catch (error) {
      console.error("MT5 connection failed:", error.message);
      throw error;
    }
  }

  async disconnect() {
    try {
      const response = await axios.post(`${BASE_URL}/disconnect`);
      this.isConnected = false;
      return response.data.message;
    } catch (error) {
      console.error("MT5 disconnect failed:", error.message);
      throw error;
    }
  }

  async getSymbols() {
    try {
      const response = await axios.get(`${BASE_URL}/symbols`);
      return response.data.data;
    } catch (error) {
      console.error("Symbol fetch failed:", error.message);
      throw error;
    }
  }

  async getSymbolInfo(symbol) {
    try {
      const encodedSymbol = encodeURIComponent(symbol);
      const response = await axios.get(
        `${BASE_URL}/symbol_info/${encodedSymbol}`
      );
      return response.data.data;
    } catch (error) {
      console.error(`Symbol info fetch failed for ${symbol}:`, error.message);
      throw error;
    }
  }

  async getPrice(symbol = process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix") {
    try {
      const encodedSymbol = encodeURIComponent(symbol);
      const response = await axios.get(`${BASE_URL}/price/${encodedSymbol}`);
      const priceData = response.data.data;
      this.priceData.set(symbol, {
        bid: priceData.bid,
        ask: priceData.ask,
        spread: priceData.spread,
        timestamp: new Date(priceData.time),
      });
      this.lastPriceUpdate.set(symbol, Date.now());
      return priceData;
    } catch (error) {
      console.error(`Price fetch failed for ${symbol}:`, error.message);
      throw error;
    }
  }

  async getPositions() {
    try {
      const response = await axios.get(`${BASE_URL}/positions`);
      return response.data.data;
    } catch (error) {
      console.error("Positions fetch failed:", error.message);
      throw error;
    }
  }

  async validateSymbol(symbol) {
    try {
      const symbols = await this.getSymbols();
      if (symbols.includes(symbol)) {
        const info = await this.getSymbolInfo(symbol);
        if (info.trade_mode !== 0) {
          console.log(
            `Validated symbol ${symbol} with filling mode: ${info.filling_mode}`
          );
          return symbol;
        }
        console.warn(`Symbol ${symbol} not tradable`);
      }
      const matches = symbols.filter(
        (s) =>
          s.toLowerCase().includes(symbol.toLowerCase()) ||
          s.toLowerCase().includes("xau") ||
          s.toLowerCase().includes("gold") ||
          s === process.env.MT5_SYMBOL ||
          s === "XAUUSD_TTBAR.Fix" ||
          s === "XAUUSD"
      );
      for (const match of matches) {
        const info = await this.getSymbolInfo(match);
        if (info.trade_mode !== 0) {
          console.log(
            `Alternative symbol ${match} validated with filling mode: ${info.filling_mode}`
          );
          return match;
        }
      }
      throw new Error(
        `Symbol ${symbol} not found or tradable. Alternatives: ${matches.join(
          ", "
        )}`
      );
    } catch (error) {
      console.error(`Symbol validation failed for ${symbol}:`, error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      if (!this.isConnected) throw new Error("Not connected");
      const testResult = await this.getPrice(
        process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix"
      );
      console.log("Connection test passed:", testResult);
      return { success: true, message: "MT5 working", testPrice: testResult };
    } catch (error) {
      console.error("Connection test failed:", error);
      return {
        success: false,
        message: "MT5 test failed",
        error: error.message,
      };
    }
  }

  async checkMarketHours(symbol) {
    const adminContact = "+971 58 502 3411";
    try {
      const validSymbol = await this.validateSymbol(symbol);
      const info = await this.getSymbolInfo(validSymbol);

      // Check MT5 trade_mode
      if (info.trade_mode === 0) {
        return {
          isOpen: false,
          error: `⚠️ Market is closed. Please contact our support team at ${adminContact} for assistance.`,
        };
      }

      // Fallback: Check forex market hours (Monday 00:00 to Friday 23:59 UTC)
      const now = new Date();
      const dubaiOffset = 4 * 60; // Dubai is UTC+4
      const utcTime = new Date(now.getTime() - dubaiOffset * 60 * 1000);
      const dayOfWeek = utcTime.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      const hours = utcTime.getUTCHours();
      const minutes = utcTime.getUTCMinutes();
      const timeInMinutes = hours * 60 + minutes;

      // Forex market is typically open from Monday 00:00 UTC to Friday 23:59 UTC
      const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday

      if (!isMarketOpen) {
        return {
          isOpen: false,
          error: `⚠️ Market is closed. Please contact our support team at ${adminContact} for assistance.`,
        };
      }

      return { isOpen: true, error: null };
    } catch (error) {
      console.error(`Market hours check failed for ${symbol}:`, error.message);
      return {
        isOpen: false,
        error: `⚠️ Market is closed or unavailable. Please contact our support team at ${adminContact} for assistance.`,
      };
    }
  }

  async placeTrade(tradeData, retryCount = 0) {
    const maxRetries = 3;
    const adminContact = "+971 58 502 3411";
    try {
      if (!(await this.testConnection()).success) {
        throw new Error("MT5 connection test failed");
      }

      // Check market hours before placing trade
      const marketStatus = await this.checkMarketHours(
        tradeData.symbol || process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix"
      );
      if (!marketStatus.isOpen) {
        throw new Error(marketStatus.error);
      }

      const symbol = await this.validateSymbol(
        tradeData.symbol || process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix"
      );
      const info = await this.getSymbolInfo(symbol);

      let volume = parseFloat(tradeData.volume);
      if (isNaN(volume) || volume < info.volume_min) {
        throw new Error(`Volume ${volume} below minimum ${info.volume_min}`);
      }
      if (volume > info.volume_max) {
        throw new Error(`Volume ${volume} exceeds maximum ${info.volume_max}`);
      }
      volume = Math.round(volume / info.volume_step) * info.volume_step;

      let slDistance = tradeData.slDistance;
      let tpDistance = tradeData.tpDistance;

      if (slDistance !== null && slDistance !== undefined && slDistance > 0) {
        const stopLevel = info.stops_level * info.point;
        slDistance = parseFloat(slDistance);
        if (slDistance < stopLevel) slDistance = stopLevel;
      }

      if (tpDistance !== null && tpDistance !== undefined && tpDistance > 0) {
        const stopLevel = info.stops_level * info.point;
        tpDistance = parseFloat(tpDistance);
        if (tpDistance < stopLevel) tpDistance = stopLevel;
      }

      let comment =
        tradeData.comment || `Ord-${Date.now().toString().slice(-6)}`;
      if (comment.length > 26) {
        comment = comment.slice(0, 26);
      }

      const request = {
        symbol: symbol,
        volume: volume,
        type: tradeData.type.toUpperCase(),
        sl_distance: slDistance,
        tp_distance: tpDistance,
        comment: comment,
        magic: tradeData.magic || 123456,
      };

      console.log("Sending trade request:", JSON.stringify(request, null, 2));
      const response = await axios.post(`${BASE_URL}/trade`, request);
      console.log("API response:", JSON.stringify(response.data, null, 2));
      const result = response.data.data;
      if (!response.data.success)
        throw new Error(result.error || "MT5 trade failed");

      return {
        success: true,
        ticket: result.order || result.deal,
        deal: result.deal,
        volume: result.volume,
        price: result.price,
        symbol: symbol,
        type: tradeData.type,
        sl: result.sl,
        tp: result.tp,
        comment: result.comment,
        retcode: result.retcode,
      };
    } catch (error) {
      const errorCode = error.response?.data?.error?.match(/Code: (\d+)/)?.[1];
      const errorMessage = errorCode
        ? {
            10018: `⚠️ Market is closed. Please contact our support team at ${adminContact} for assistance.`,
            10019: "Insufficient funds. Please check your balance.",
            10020: "Prices have changed. Please try again.",
            10021:
              "Invalid request. Please check volume, symbol, or market status.",
            10022: "Invalid Stop Loss or Take Profit levels.",
            10017: "Invalid parameters provided.",
            10027: "AutoTrading is disabled.",
            10030: "Invalid order filling type.",
          }[parseInt(errorCode)] || `Unknown error: ${error.message}`
        : error.message.includes("connection")
        ? `MT5 connection issue. Please contact support at ${adminContact}.`
        : error.message.includes("Market closed")
        ? `⚠️ Market is closed. Please contact our support team at ${adminContact} for assistance.`
        : `Error: ${error.message}. Please contact support at ${adminContact}.`;

      if (
        (errorCode === "10020" || errorCode === "10021") &&
        retryCount < maxRetries
      ) {
        console.log(
          `Retrying trade (${
            retryCount + 1
          }/${maxRetries}) for error: ${errorMessage}`
        );
        await new Promise((r) => setTimeout(r, 1000));
        return this.placeTrade(
          { ...tradeData, deviation: (tradeData.deviation || 20) + 10 },
          retryCount + 1
        );
      }
      console.error("Trade placement failed:", error);
      throw new Error(errorMessage);
    }
  }

  async closeTrade(tradeData, retryCount = 0) {
    const maxRetries = 3;
    const adminContact = "+971 58 502 3411";
    try {
      if (!tradeData.ticket || isNaN(tradeData.ticket)) {
        throw new Error(`Invalid ticket: ${tradeData.ticket}`);
      }
      if (!tradeData.symbol) {
        throw new Error(`Missing symbol`);
      }

      // Check market hours before closing trade
      const marketStatus = await this.checkMarketHours(tradeData.symbol);
      if (!marketStatus.isOpen) {
        throw new Error(marketStatus.error);
      }

      const validSymbol = await this.validateSymbol(tradeData.symbol);
      const info = await this.getSymbolInfo(validSymbol);

      console.log(`Fetching positions for ticket ${tradeData.ticket}`);
      const positions = await this.getPositions();
      if (!positions || !Array.isArray(positions)) {
        throw new Error(
          `Failed to retrieve positions for ticket: ${tradeData.ticket}`
        );
      }
      const position = positions.find(
        (p) => p.ticket === parseInt(tradeData.ticket)
      );

      if (!position) {
        console.warn(
          `Position not found in initial check for ticket ${tradeData.ticket}. Attempting MT5 closure.`
        );
        const request = {
          ticket: parseInt(tradeData.ticket),
          symbol: validSymbol,
          volume: parseFloat(tradeData.volume),
          type: tradeData.type.toUpperCase(),
        };
        const response = await axios.post(`${BASE_URL}/close`, request);
        const result = response.data.data;

        if (!result || typeof result !== "object") {
          throw new Error(
            "Invalid response from MT5: result is undefined or not an object"
          );
        }

        const isStructuredResponse =
          result.success !== undefined && result.data;
        const retcode = isStructuredResponse
          ? result.data.retcode
          : result.retcode;
        if (
          (isStructuredResponse && result.success && retcode === 10009) ||
          (!isStructuredResponse && retcode === 10009)
        ) {
          console.log(
            `Trade closed successfully in MT5 for ticket ${tradeData.ticket}`
          );
          return {
            success: true,
            ticket: tradeData.ticket,
            closePrice:
              (isStructuredResponse ? result.data.price : result.price) || 0,
            profit:
              (isStructuredResponse ? result.data.profit : result.profit) || 0,
            symbol: validSymbol,
            data: {
              deal: isStructuredResponse ? result.data.deal : result.deal,
              retcode: retcode,
              price:
                (isStructuredResponse ? result.data.price : result.price) || 0,
              profit:
                (isStructuredResponse ? result.data.profit : result.profit) ||
                0,
              volume:
                (isStructuredResponse ? result.data.volume : result.volume) ||
                tradeData.volume,
              symbol:
                (isStructuredResponse ? result.data.symbol : result.symbol) ||
                validSymbol,
              position_type: isStructuredResponse
                ? result.data.position_type
                : tradeData.type,
            },
          };
        }
        if (result.error && result.error.includes("Position not found")) {
          console.warn(
            `Position ${tradeData.ticket} not found in MT5. Likely already closed.`
          );
          return {
            success: false,
            error: `Position ${tradeData.ticket} not found in MT5`,
            ticket: tradeData.ticket,
            likelyClosed: true,
          };
        }
        throw new Error(
          result.error || `Close failed: Retcode: ${retcode || "Unknown"}`
        );
      }

      let volume = parseFloat(position.volume);
      if (!volume || isNaN(volume) || volume <= 0) {
        throw new Error(
          `Invalid position volume: ${volume} for ticket: ${tradeData.ticket}`
        );
      }

      if (volume < info.volume_min) {
        throw new Error(
          `Volume ${volume} is below minimum ${info.volume_min} for ${validSymbol}`
        );
      }
      if (volume > info.volume_max) {
        throw new Error(
          `Volume ${volume} exceeds maximum ${info.volume_max} for ${validSymbol}`
        );
      }
      volume = Math.round(volume / info.volume_step) * info.volume_step;
      console.log(`Validated volume: ${volume} for ticket ${tradeData.ticket}`);

      const priceData = await this.getPrice(validSymbol);
      const closePrice =
        tradeData.type.toUpperCase() === "BUY" ? priceData.bid : priceData.ask;

      const profit = tradeData.openingPrice
        ? tradeData.type.toUpperCase() === "BUY"
          ? (closePrice - tradeData.openingPrice) * volume
          : (tradeData.openingPrice - closePrice) * volume
        : position.profit || 0;

      const request = {
        ticket: parseInt(tradeData.ticket),
        symbol: validSymbol,
        volume: volume,
        type: tradeData.type.toUpperCase(),
      };
      console.log(
        `Sending close trade request: ${JSON.stringify(
          request,
          null,
          2
        )} with price ${closePrice}`
      );

      const response = await axios.post(`${BASE_URL}/close`, request);
      const result = response.data.data;
      if (!result || typeof result !== "object") {
        throw new Error(
          "Invalid response from MT5: result is undefined or not an object"
        );
      }

      console.log(`MT5 response: ${JSON.stringify(result, null, 2)}`);

      const isStructuredResponse = result.success !== undefined && result.data;
      const retcode = isStructuredResponse
        ? result.data.retcode
        : result.retcode;
      const deal = isStructuredResponse ? result.data.deal : result.deal;
      const price = isStructuredResponse ? result.data.price : result.price;
      const volumeResult = isStructuredResponse
        ? result.data.volume
        : result.volume;
      const profitResult = isStructuredResponse
        ? result.data.profit
        : result.profit;
      const symbolResult = isStructuredResponse
        ? result.data.symbol
        : result.symbol;

      if (
        (isStructuredResponse && result.success && retcode === 10009) ||
        (!isStructuredResponse && retcode === 10009)
      ) {
        console.log(`Trade closed successfully for ticket ${tradeData.ticket}`);
        return {
          success: true,
          ticket: tradeData.ticket,
          closePrice: price || closePrice,
          profit: profitResult !== undefined ? profitResult : profit,
          symbol: symbolResult || validSymbol,
          data: {
            deal: deal,
            retcode: retcode,
            price: price || closePrice,
            profit: profitResult !== undefined ? result.profit : profit,
            volume: volumeResult || volume,
            symbol: symbolResult || validSymbol,
            position_type: isStructuredResponse
              ? result.data.position_type
              : position.type,
          },
        };
      }

      const errorMsg = isStructuredResponse
        ? result.error || `Close failed: Retcode: ${retcode || "Unknown"}`
        : `Close failed: Retcode: ${retcode || "Unknown"}`;
      if (errorMsg.includes("10021") && retryCount < maxRetries) {
        console.log(
          `Retrying close (${retryCount + 1}/${maxRetries}) for ticket ${
            tradeData.ticket
          } due to ${errorMsg}`
        );
        await new Promise((r) => setTimeout(r, 1000));
        return this.closeTrade(
          {
            ...tradeData,
            volume: position.volume,
            deviation: (tradeData.deviation || 20) + 10,
          },
          retryCount + 1
        );
      }
      throw new Error(errorMsg);
    } catch (error) {
      const errorCode =
        error.response?.data?.error?.match(/Retcode: (\d+)/)?.[1] ||
        error.response?.data?.error?.match(/-?\d+/)?.[0];
      const errorMessage = errorCode
        ? {
            10013: "Requote detected. Please try again.",
            10018: `⚠️ Market is closed. Please contact our support team at ${adminContact} for assistance.`,
            10019: "Insufficient funds. Please check your balance.",
            10020: "Prices have changed. Please try again.",
            10021:
              "Invalid request. Please check volume, symbol, or market status.",
            10022: "Invalid Stop Loss or Take Profit levels.",
            10017: "Invalid parameters provided.",
            10027: "AutoTrading is disabled. Please contact support.",
            "-2": `Invalid volume argument: Requested ${tradeData.volume}`,
          }[errorCode] || `Unknown error: ${error.message}`
        : error.message.includes("connection")
        ? `MT5 connection issue. Please contact support at ${adminContact}.`
        : error.message.includes("Market closed")
        ? `⚠️ Market is closed. Please contact our support team at ${adminContact} for assistance.`
        : error.message.includes("Position not found")
        ? `Position ${tradeData.ticket} not found in MT5`
        : `Error: ${error.message}. Please contact support at ${adminContact}.`;

      console.error(
        `Trade close failed for ticket ${tradeData.ticket}: ${errorMessage}, Stack: ${error.stack}`
      );
      return {
        success: false,
        error: errorMessage,
        ticket: tradeData.ticket,
        likelyClosed: errorMessage.includes("Position not found"),
      };
    }
  }

  getCachedPrice(symbol = process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix") {
    return this.priceData.get(symbol);
  }

  isPriceFresh(
    symbol = process.env.MT5_SYMBOL || "XAUUSD_TTBAR.Fix",
    maxAge = 5000
  ) {
    return (
      this.lastPriceUpdate.get(symbol) &&
      Date.now() - this.lastPriceUpdate.get(symbol) < maxAge
    );
  }
}

const mt5Service = new MT5Service();
export default mt5Service;