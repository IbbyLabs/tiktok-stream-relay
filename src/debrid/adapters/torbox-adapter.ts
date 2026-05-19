import axios from "axios";
import {
  DebridAdapter,
  DebridRouteRequest,
  DebridRouteResult,
} from "../types.js";
import { maskToken } from "../token-safe-log.js";

export class TorboxAdapter implements DebridAdapter {
  public readonly provider = "torbox" as const;

  private assertSuccess(value: unknown, code: string): void {
    if (!value || typeof value !== "object") {
      throw new Error(`${code}_invalid_payload`);
    }
    const payload = value as {
      success?: boolean;
      error?: string | null;
      detail?: string;
    };
    if (payload.success === false) {
      const reason = payload.error ?? payload.detail ?? "unknown";
      throw new Error(`${code}_${reason}`);
    }
  }

  private assertHttpOk(status: number, code: string): void {
    if (status < 200 || status >= 300) {
      throw new Error(`${code}_http_${status}`);
    }
  }

  private assertRoutedUrl(value: unknown, code: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${code}_missing_url`);
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${code}_invalid_url`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${code}_unsupported_protocol`);
    }
    return value;
  }

  public async route(request: DebridRouteRequest): Promise<DebridRouteResult> {
    console.log(
      `debrid route request: provider=torbox token=${maskToken(request.token)}`,
    );
    const createResponse = await axios.post(
      "https://api.torbox.app/v1/api/webdl/createwebdownload",
      new URLSearchParams({ link: request.sourceUrl }).toString(),
      {
        timeout: 6000,
        headers: {
          Authorization: `Bearer ${request.token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
      },
    );
    this.assertHttpOk(createResponse.status, "torbox_createwebdownload");

    const createData = createResponse.data as {
      success?: boolean;
      error?: string | null;
      detail?: string;
      data?: {
        webdownload_id?: number;
      };
    };
    this.assertSuccess(createData, "torbox_createwebdownload");
    const webId = createData.data?.webdownload_id;
    if (!webId) {
      throw new Error(createData.error ?? "torbox_createwebdownload_failed");
    }

    const requestDlResponse = await axios.get(
      "https://api.torbox.app/v1/api/webdl/requestdl",
      {
        timeout: 6000,
        params: {
          token: request.token,
          web_id: webId,
          file_id: 0,
        },
      },
    );
    this.assertHttpOk(requestDlResponse.status, "torbox_requestdl");

    const requestDlData = requestDlResponse.data as {
      success?: boolean;
      error?: string | null;
      detail?: string;
      data?: string;
    };
    this.assertSuccess(requestDlData, "torbox_requestdl");
    const routed = this.assertRoutedUrl(requestDlData.data, "torbox_requestdl");

    return {
      provider: this.provider,
      url: routed,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
  }
}
