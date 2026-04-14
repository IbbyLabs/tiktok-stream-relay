import axios from "axios";
import {
  DebridAdapter,
  DebridRouteRequest,
  DebridRouteResult,
} from "../types.js";
import { maskToken } from "../token-safe-log.js";

export class TorboxAdapter implements DebridAdapter {
  public readonly provider = "torbox" as const;

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

    const createData = createResponse.data as {
      success?: boolean;
      error?: string | null;
      detail?: string;
      data?: {
        webdownload_id?: number;
      };
    };
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

    const requestDlData = requestDlResponse.data as {
      success?: boolean;
      error?: string | null;
      detail?: string;
      data?: string;
    };
    const routed = requestDlData.data;
    if (!routed || typeof routed !== "string") {
      throw new Error(requestDlData.error ?? "torbox_requestdl_failed");
    }

    return {
      provider: this.provider,
      url: routed,
    };
  }
}
