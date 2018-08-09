import querystring from 'querystring';
import { RequestError } from 'request-promise-native/errors';

import retryingRequest from './retryingRequest';
import WarcraftLogsApiError from './WarcraftLogsApiError';

const WCL_DOMAIN = process.env.WARCRAFT_LOGS_DOMAIN;
const WCL_MAINTENANCE_STRING = 'Warcraft Logs is down for maintenance';
export const WCL_REPORT_DOES_NOT_EXIST_HTTP_CODE = 400;
const USER_AGENT = process.env.USER_AGENT;
const WCL_API_KEY = process.env.WCL_API_KEY;
const TIMEOUT = 4000; // ms after which to abort the request
const MAX_ATTEMPTS = 2;

function getWclApiUrl(path, query) {
  return `${WCL_DOMAIN}/v1/${path}?${querystring.stringify({
    api_key: WCL_API_KEY,
    ...query,
  })}`;
}
function tryJsonParse(string) {
  let json = null;
  try {
    json = JSON.parse(string);
  } catch (jsonErr) {
    // ignore
  }
  return json;
}
export default async function fetchFromWarcraftLogsApi(path, query, attempt = 1) {
  const url = getWclApiUrl(path, query);
  try {
    const jsonString = await retryingRequest({
      url,
      headers: {
        'User-Agent': USER_AGENT,
      },
      // using gzip is 80% quicker
      gzip: true,
      // we'll be making several requests, so pool connections
      forever: true,
      timeout: TIMEOUT,
      maxAttempts: MAX_ATTEMPTS,
    });

    // WCL maintenance mode returns 200 http code :(
    if (jsonString.includes(WCL_MAINTENANCE_STRING)) {
      throw new WarcraftLogsApiError(503, WCL_MAINTENANCE_STRING);
    }
    // WCL has a tendency to throw non-JSON errors with a 200 HTTP exception, this ensures they're not accepted and cached.
    // Decoding JSON takes a long time, grabbing the first character is near instant and has high accuracy.
    const firstCharacter = jsonString.substr(0, 1);
    if (firstCharacter !== '{' && firstCharacter !== '[') {
      throw new WarcraftLogsApiError(500, 'Corrupt Warcraft Logs API response received', jsonString);
    }

    return jsonString;
  } catch (err) {
    if (err instanceof WarcraftLogsApiError) {
      // Already the correct format, pass it along
      throw err;
    } else if (err instanceof RequestError) {
      // An error occured connecting or during the transmission
      const code = err.error.code;
      switch (code) {
        case 'ETIMEDOUT':
          throw new WarcraftLogsApiError(504, 'Warcraft Logs took too long to respond.', err);
        case 'ECONNRESET':
          throw new WarcraftLogsApiError(504, 'Warcraft Logs disconnected', err);
        case 'ESOCKETTIMEDOUT':
          throw new WarcraftLogsApiError(504, 'Warcraft Logs disconnected', err);
        default:
          throw new WarcraftLogsApiError(500, 'An unknown error occured.', err);
      }
    }

    const statusCode = err.statusCode || 500;
    if (err.error) {
      const json = tryJsonParse(err.error);
      if (json) {
        throw new WarcraftLogsApiError(statusCode, json.error, err);
      }
    }

    const message = err.error || err.message;
    throw new WarcraftLogsApiError(statusCode, message, err);
  }
}
