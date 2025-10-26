import pkg from "twilio";
const { Twilio, twiml } = pkg;
const { MessagingResponse } = twiml;
import dotenv from "dotenv";
import { getUserSession, updateUserSession } from "../../services/market/sessionService.js";
import { isAuthorizedUser } from "../../services/market/userService.js";
import { processUserInputMT5 } from "../../services/market/messageService.js";
import Account from "../../models/AccountSchema.js";

// Initialize environment variables
dotenv.config();

// Initialize Twilio client
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_WHATSAPP_NUMBER;
const client = new Twilio(accountSid, authToken);

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
  const state = success ? PROCESSING_STATES.COMPLETED : PROCESSING_STATES.FAILED;
  keys.forEach((key) => {
    messageProcessingState.set(key, { state, timestamp: Date.now() });
  });
  setTimeout(
    () => keys.forEach((key) => messageProcessingState.delete(key)),
    MESSAGE_CACHE_TTL
  );
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
      await sendMessage(From, `🚫 Access Denied\nYour number is not registered.\n\n📞 Support: Ajmal TK +971 58 502 3411`);
      success = true;
      return;
    }

    const account = await Account.findById(authResult.accountId).lean();
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
    await sendMessage(From, `❌ ${error.message}\nType MENU.`);
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