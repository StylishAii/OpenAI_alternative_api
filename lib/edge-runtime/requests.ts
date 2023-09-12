import { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Json } from "../database.types";
import { ActionToHttpRequest } from "../models";
import { Action } from "../types";
import { deduplicateArray, filterKeys } from "../utils";
import { getHeader, getJsonMIMEType } from "./utils";
import MediaTypeObject = OpenAPIV3_1.MediaTypeObject;
import { fillNoChoiceRequiredParams } from "../actionUtils";

export function processAPIoutput(
  out: Json | Json[],
  chosenAction: Action
): Json | Json[] {
  if (Array.isArray(out)) {
    out = deduplicateArray(out) as Json[];
  }
  const keys = chosenAction.keys_to_keep;
  if (keys && Array.isArray(keys) && keys.every((k) => typeof k === "string")) {
    out = filterKeys(out, keys as string[]);
  }
  return out;
}

export function constructHttpRequest({
  action,
  parameters,
  organization,
  userApiKey,
  stream,
}: ActionToHttpRequest): { url: string; requestOptions: RequestInit } {
  if (!action.path) {
    throw new Error("Path is not provided");
  }
  if (!action.request_method) {
    throw new Error("Request method is not provided");
  }
  if (!action.api_host) {
    throw new Error("API host has not been provided");
  }

  console.log("Constructing http request for action:", JSON.stringify(action));
  console.log("parameters:", parameters);

  const headers: Record<string, string> = {};
  // TODO: You can only overwrite this header if it's in the parameters
  headers["Accept"] = "application/json";
  if (userApiKey) {
    const scheme = action.auth_scheme ? action.auth_scheme + " " : "";
    headers[action.auth_header] = `${scheme}${userApiKey}`;
  }

  if (action.api_host.includes("api/mock"))
    headers["org_id"] = organization.id.toString();
  // This header is only required for requests with a body
  if (action.request_body_contents)
    headers["Content-Type"] = "application/json";

  const requestOptions: RequestInit = {
    method: action.request_method.toUpperCase(),
  };

  // Request body
  if (action.request_method !== "GET" && action.request_body_contents) {
    const schema = bodyPropertiesFromRequestBodyContents(
      action.request_body_contents
    );
    const allParams = fillNoChoiceRequiredParams(parameters, schema);
    const body = buildBody(schema, allParams);
    requestOptions.body = JSON.stringify(body);
  }

  // Below URL(...).href deals with "/" between the path and host
  let url = action.api_host + action.path;
  // let url = new URL(action.path, action.api_host).href
  //   // These are because path parameters can be in action.path e.g. /{param}
  //   // and above line encodes them into %7B and %7D
  //   .replaceAll("%7B", "{")
  //   .replaceAll("%7D", "}");

  // TODO: accept array for JSON?
  // Set parameters
  if (action.parameters && Array.isArray(action.parameters)) {
    const queryParams = new URLSearchParams();
    const actionParameters =
      action.parameters as unknown as OpenAPIV3_1.ParameterObject[];

    for (const param of actionParameters) {
      console.log(`processing param: ${JSON.stringify(param)}`);
      // Check for case of required parameter that has enum with 1 value
      const schema = param.schema as OpenAPIV3.SchemaObject;
      if (param.required && schema.enum && schema.enum.length === 1) {
        // Fill in the required parameter with the enum value
        parameters[param.name] = schema.enum[0];
      }

      if (!parameters[param.name]) {
        console.log("Parameter not provided:", param.name);
        continue;
      }

      if (param.in === "path") {
        url = url.replace(
          `{${param.name}}`,
          encodeURIComponent(String(parameters[param.name]))
        );
      } else if (param.in === "query") {
        queryParams.set(param.name, String(parameters[param.name]));
      } else if (param.in === "header") {
        headers[param.name] = String(parameters[param.name]);
      } else if (param.in === "cookie") {
        headers["Cookie"] = `${param}=${String(parameters[param.name])}`;
      } else {
        throw new Error(
          `Parameter "${param.name}" has invalid location: ${param.in}`
        );
      }
    }
    // Below only adds query params if there are any query params
    if ([...queryParams.entries()].length > 0) {
      url += `?${queryParams.toString()}`;
    }
  }
  requestOptions.headers = headers;
  const logMessage = `Attempting fetch with url: ${url}\n\nWith options:${JSON.stringify(
    requestOptions,
    null,
    2
  )}`;
  console.log(logMessage);

  if (stream)
    stream({
      role: "debug",
      content: logMessage,
    });

  return { url, requestOptions };
}

export function bodyPropertiesFromRequestBodyContents(
  requestBodyContents: Json
): OpenAPIV3.SchemaObject {
  const reqBodyContents = requestBodyContents as unknown as {
    [media: string]: MediaTypeObject;
  };

  console.log("reqBodyContents:", reqBodyContents);

  // TODO: Only application/json supported for now
  const applicationJson = getJsonMIMEType(reqBodyContents);
  if (!applicationJson) {
    throw new Error(
      "Only application/json request body contents are supported"
    );
  }

  return applicationJson.schema as OpenAPIV3.SchemaObject;
}

function buildBody(
  schema: OpenAPIV3.SchemaObject,
  parameters: Record<string, unknown>
): { [x: string]: any } {
  const properties = schema.properties as {
    [name: string]: OpenAPIV3_1.SchemaObject;
  };
  console.log("properties:", JSON.stringify(properties));

  const bodyArray = Object.entries(properties).map(([name, property]) => {
    // Throw out readonly attributes
    if (property.readOnly) return undefined;
    if (parameters[name]) {
      return { [name]: parameters[name] };
    }
  });
  return Object.assign({}, ...bodyArray);
}

export async function makeHttpRequest(
  url: string,
  requestOptions: RequestInit,
  localHostname: string
): Promise<Json> {
  // TODO: Don't handle redirects manually
  // Why handle 3XX's manually? Because Companies House likes 302 redirects,
  //  but it throws an error if you have the headers from the first request set
  //  (specifically the Authorization header)
  let response = await fetch(url, { ...requestOptions, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    // Try requesting from here without auth headers
    console.log("Attempting manual redirect");

    if (!response.headers.has("location")) {
      return {
        status: "Redirect failed as original request did not return location",
      };
    }
    const headers = requestOptions.headers;
    if (headers) {
      if ("Authorization" in headers) delete headers["Authorization"];
      if ("authorization" in headers) delete headers["authorization"];
    }
    requestOptions.headers = headers;
    const { origin } = new URL(url);

    const redirectUrl = response.headers.get("location")!.includes(origin)
      ? response.headers.get("location")!
      : new URL(response.headers.get("location")!, origin).href;

    console.log("Attempting fetch with redirected url: ", redirectUrl);
    response = await fetch(redirectUrl, requestOptions);
  }
  // Deal with response with potentially empty body (stackoverflow.com/a/51320025)
  const responseStatus = response.status ?? 0;
  const responseText = await response.text();
  // If there's no response body, return a status message
  if (!responseText) {
    return responseStatus >= 200 && responseStatus < 300
      ? { status: "Action completed successfully" }
      : { status: "Action failed" };
  }

  if (responseStatus >= 300)
    return (
      `The function returned a ${responseStatus}, the response was: ` +
      responseText
    );

  const reqHeaders: Record<string, any> | null =
    requestOptions?.headers ?? null;

  if (!reqHeaders) {
    return responseText;
  }

  const accept = getHeader(reqHeaders, "Accept") ?? "application/json";

  if (accept === "application/json") {
    return JSON.parse(responseText);
  } else if (
    [
      "application/html",
      "application/html+xml",
      "application/xml",
      "application/xhtml",
      "application/xhtml+xml",
    ].includes(accept)
  ) {
    // This parses the html into text
    const res = await fetch(`${localHostname}/api/parse-html`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ html: responseText }),
    });
    return res.text();
  }
  return responseText;
}
