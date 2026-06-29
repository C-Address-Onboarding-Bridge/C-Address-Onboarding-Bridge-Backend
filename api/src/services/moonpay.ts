import crypto from 'crypto';
import { config } from '../config';

interface MoonpayWidgetParams {
  apiKey: string;
  currencyCode: string;
  walletAddress: string;
  walletNetwork: string;
  baseCurrencyAmount?: number;
  baseCurrencyCode?: string;
  email?: string;
}

/** Handles MoonPay widget URL generation and webhook signature verification. */
export class MoonpayService {
  private apiKey: string;
  private secretKey: string;

  constructor() {
    this.apiKey = config.moonpay.apiKey;
    this.secretKey = config.moonpay.secretKey;
  }

  /**
   * Builds a signed MoonPay widget URL for the given parameters.
   *
   * @param params - Widget configuration; `apiKey` is injected automatically.
   * @returns Fully-formed URL to open in a browser or WebView.
   */
  generateWidgetUrl(params: Omit<MoonpayWidgetParams, 'apiKey'>): string {
    const queryParams = new URLSearchParams({
      apiKey: this.apiKey,
      currencyCode: params.currencyCode,
      walletAddress: params.walletAddress,
      walletNetwork: params.walletNetwork,
    });

    if (params.baseCurrencyAmount) {
      queryParams.set('baseCurrencyAmount', params.baseCurrencyAmount.toString());
    }
    if (params.baseCurrencyCode) {
      queryParams.set('baseCurrencyCode', params.baseCurrencyCode);
    }
    if (params.email) {
      queryParams.set('email', params.email);
    }

    const baseUrl = 'https://buy.moonpay.com';
    return `${baseUrl}?${queryParams.toString()}`;
  }

  /**
   * Verifies a MoonPay webhook signature using HMAC-SHA256.
   * Returns `false` if the secret key is not configured.
   *
   * @param payload - Raw request body string.
   * @param signature - Value of the `x-moonpay-signature` header.
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.secretKey || !signature) return false;
    const expected = crypto
      .createHmac('sha256', this.secretKey)
      .update(payload, 'utf8')
      .digest('base64');

    if (expected.length !== signature.length) return false;

    return crypto.timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(signature, 'ascii'));
  }
}

export const moonpayService = new MoonpayService();
