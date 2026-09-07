import type {
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  SupportedResponse,
  VerifyResponse,
} from "./types.js";
import { X402_VERSION } from "./types.js";

/**
 * Client for an x402 facilitator.
 *
 * The facilitator is the only party that can complete a Hedera `exact` payment: it holds the
 * fee-payer key, adds the missing signature, and submits. See ADR 0001 for why this project
 * settles through Blocky402 specifically.
 */
export class Facilitator {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Capabilities. Also the source of `extra.feePayer` - never hardcode that value. */
  async supported(): Promise<SupportedResponse> {
    return this.get<SupportedResponse>("/supported");
  }

  /**
   * Resolve the fee payer for a network from `/supported`.
   *
   * The fee payer is facilitator-operated and can change. Reading it per run costs one
   * request and removes a whole class of "worked yesterday" failure.
   */
  async feePayerFor(network: string): Promise<string> {
    const { kinds } = await this.supported();
    const match = kinds.find((k) => k.network === network && k.scheme === "exact");
    if (!match) {
      const offered = kinds.map((k) => `${k.scheme}@${k.network}`).join(", ") || "none";
      throw new Error(
        `Facilitator does not support scheme "exact" on network "${network}". Offers: ${offered}`,
      );
    }
    const feePayer = match.extra?.feePayer;
    if (!feePayer) {
      throw new Error(`Facilitator advertises "exact" on ${network} but returned no extra.feePayer`);
    }
    return feePayer;
  }

  /** Read-only validation. Does not move funds and does not commit payment state. */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
    });
  }

  /** Signs as fee payer and submits to the network. This is the irreversible step. */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    return this.post<SettlementResponse>("/settle", {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
    });
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return this.parse<T>(res, "GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(res, "POST", path);
  }

  /**
   * Surface the facilitator's own error text rather than a bare status code - its messages
   * name the offending field, which is most of the debugging on a wire format this strict.
   */
  private async parse<T>(res: Response, method: string, path: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${this.baseUrl}${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}
