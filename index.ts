#!/usr/bin/env node
import { z, type ZodTypeAny } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Type definitions for tool arguments
interface ListChannelsArgs {
  limit?: number;
  cursor?: string;
}

interface PostMessageArgs {
  channel_id: string;
  text: string;
}

interface ReplyToThreadArgs {
  channel_id: string;
  thread_ts: string;
  text: string;
}

interface AddReactionArgs {
  channel_id: string;
  timestamp: string;
  reaction: string;
}

interface GetChannelHistoryArgs {
  channel_id: string;
  limit?: number;
}

interface GetThreadRepliesArgs {
  channel_id: string;
  thread_ts: string;
}

interface GetUsersArgs {
  cursor?: string;
  limit?: number;
}

interface GetUserProfileArgs {
  user_id: string;
}

export class SlackClient {
  private botHeaders: { Authorization: string; "Content-Type": string };
  private teamId: string;
  private channelIds: string[] | undefined;

  constructor(botToken: string, teamId: string, channelIds?: string[]) {
    this.botHeaders = {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    };
    this.teamId = teamId;
    this.channelIds = channelIds;
  }

  async getChannels(limit: number = 100, cursor?: string): Promise<any> {
    const predefinedChannelIds = this.channelIds?.length
      ? this.channelIds
      : undefined;
    if (!predefinedChannelIds) {
      const params = new URLSearchParams({
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: Math.min(limit, 200).toString(),
        team_id: this.teamId,
      });

      if (cursor) {
        params.append("cursor", cursor);
      }

      const response = await fetch(
        `https://slack.com/api/conversations.list?${params}`,
        { headers: this.botHeaders },
      );

      return response.json();
    }

    const predefinedChannelIdsArray = predefinedChannelIds;
    const channels = [];

    for (const channelId of predefinedChannelIdsArray) {
      const params = new URLSearchParams({
        channel: channelId,
      });

      const response = await fetch(
        `https://slack.com/api/conversations.info?${params}`,
        { headers: this.botHeaders }
      );
      const data = await response.json();

      if (data.ok && data.channel && !data.channel.is_archived) {
        channels.push(data.channel);
      }
    }

    return {
      ok: true,
      channels: channels,
      response_metadata: { next_cursor: "" },
    };
  }

  async postMessage(channel_id: string, text: string): Promise<any> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        text: text,
      }),
    });

    return response.json();
  }

  async postReply(
    channel_id: string,
    thread_ts: string,
    text: string,
  ): Promise<any> {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        thread_ts: thread_ts,
        text: text,
      }),
    });

    return response.json();
  }

  async addReaction(
    channel_id: string,
    timestamp: string,
    reaction: string,
  ): Promise<any> {
    const response = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        timestamp: timestamp,
        name: reaction,
      }),
    });

    return response.json();
  }

  async getChannelHistory(
    channel_id: string,
    limit: number = 10,
  ): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      limit: limit.toString(),
    });

    const response = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: this.botHeaders },
    );

    return response.json();
  }

  async getThreadReplies(channel_id: string, thread_ts: string): Promise<any> {
    const params = new URLSearchParams({
      channel: channel_id,
      ts: thread_ts,
    });

    const response = await fetch(
      `https://slack.com/api/conversations.replies?${params}`,
      { headers: this.botHeaders },
    );

    return response.json();
  }

  async getUsers(limit: number = 100, cursor?: string): Promise<any> {
    const params = new URLSearchParams({
      limit: Math.min(limit, 200).toString(),
      team_id: this.teamId,
    });

    if (cursor) {
      params.append("cursor", cursor);
    }

    const response = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: this.botHeaders,
    });

    return response.json();
  }

  async getUserProfile(user_id: string): Promise<any> {
    const params = new URLSearchParams({
      user: user_id,
      include_labels: "true",
    });

    const response = await fetch(
      `https://slack.com/api/users.profile.get?${params}`,
      { headers: this.botHeaders },
    );

    return response.json();
  }
}

// ---------------------------------------------------------------------------
// RestToolServer — drop-in replacement for McpServer.
// Same registerTool() interface; exposes listTools() / callTool() for REST.
// ---------------------------------------------------------------------------

interface ToolEntry {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  handler: (args: any) => Promise<{ content: { type: string; text: string }[] }>;
}

export class RestToolServer {
  private tools = new Map<string, ToolEntry>();

  registerTool(
    name: string,
    config: { title?: string; description: string; inputSchema: Record<string, ZodTypeAny> },
    handler: (args: any) => Promise<{ content: { type: string; text: string }[] }>,
  ) {
    this.tools.set(name, {
      name,
      title: config.title ?? name,
      description: config.description,
      inputSchema: config.inputSchema,
      handler,
    });
  }

  listTools() {
    return Array.from(this.tools.values()).map(({ handler, inputSchema, ...meta }) => ({
      ...meta,
      inputSchema: zodShapeToJsonSchema(inputSchema),
    }));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    const tool = this.tools.get(name)!;
    const schema = z.object(tool.inputSchema);
    const parsed = schema.parse(args);
    const result = await tool.handler(parsed);
    return JSON.parse(result.content[0].text);
  }
}

// -- zod shape → JSON Schema helpers --

function zodShapeToJsonSchema(shape: Record<string, ZodTypeAny>) {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, zodType] of Object.entries(shape)) {
    const { prop, isRequired } = zodTypeToJsonProp(zodType);
    properties[key] = prop;
    if (isRequired) required.push(key);
  }

  return { type: "object" as const, properties, ...(required.length ? { required } : {}) };
}

function zodTypeToJsonProp(zodType: ZodTypeAny): { prop: any; isRequired: boolean } {
  const desc = zodType.description;
  let inner = zodType as any;
  let defaultValue: any;
  let hasDefault = false;
  let isOptional = false;

  if (inner._def.typeName === 'ZodDefault') {
    hasDefault = true;
    defaultValue = inner._def.defaultValue();
    inner = inner._def.innerType;
  }
  if (inner._def.typeName === 'ZodOptional') {
    isOptional = true;
    inner = inner._def.innerType;
  }

  let type = 'string';
  if (inner._def.typeName === 'ZodNumber') type = 'number';
  else if (inner._def.typeName === 'ZodBoolean') type = 'boolean';

  const prop: any = { type };
  if (desc) prop.description = desc;
  if (hasDefault) prop.default = defaultValue;

  return { prop, isRequired: !isOptional && !hasDefault };
}

// ---------------------------------------------------------------------------
// createSlackServer — tool registrations are UNCHANGED from the MCP version.
// Only the return type changed: McpServer → RestToolServer.
// ---------------------------------------------------------------------------

export function createSlackServer(slackClient: SlackClient): RestToolServer {
  const server = new RestToolServer();

  server.registerTool(
    "slack_list_channels",
    {
      title: "List Slack Channels",
      description: "List public and private channels that the bot is a member of, or pre-defined channels in the workspace with pagination",
      inputSchema: {
        limit: z.number().optional().default(100).describe("Maximum number of channels to return (default 100, max 200)"),
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
      },
    },
    async ({ limit, cursor }) => {
      const response = await slackClient.getChannels(limit, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_post_message",
    {
      title: "Post Slack Message",
      description: "Post a new message to a Slack channel or direct message to user",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel or user to post to"),
        text: z.string().describe("The message text to post"),
      },
    },
    async ({ channel_id, text }) => {
      const response = await slackClient.postMessage(channel_id, text);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_reply_to_thread",
    {
      title: "Reply to Slack Thread",
      description: "Reply to a specific message thread in Slack",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel containing the thread"),
        thread_ts: z.string().describe("The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it."),
        text: z.string().describe("The reply text"),
      },
    },
    async ({ channel_id, thread_ts, text }) => {
      const response = await slackClient.postReply(channel_id, thread_ts, text);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_add_reaction",
    {
      title: "Add Slack Reaction",
      description: "Add a reaction emoji to a message",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel containing the message"),
        timestamp: z.string().describe("The timestamp of the message to react to"),
        reaction: z.string().describe("The name of the emoji reaction (without ::)"),
      },
    },
    async ({ channel_id, timestamp, reaction }) => {
      const response = await slackClient.addReaction(channel_id, timestamp, reaction);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_channel_history",
    {
      title: "Get Slack Channel History",
      description: "Get recent messages from a channel",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel"),
        limit: z.number().optional().default(10).describe("Number of messages to retrieve (default 10)"),
      },
    },
    async ({ channel_id, limit }) => {
      const response = await slackClient.getChannelHistory(channel_id, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_thread_replies",
    {
      title: "Get Slack Thread Replies",
      description: "Get all replies in a message thread",
      inputSchema: {
        channel_id: z.string().describe("The ID of the channel containing the thread"),
        thread_ts: z.string().describe("The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it."),
      },
    },
    async ({ channel_id, thread_ts }) => {
      const response = await slackClient.getThreadReplies(channel_id, thread_ts);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_users",
    {
      title: "Get Slack Users",
      description: "Get a list of all users in the workspace with their basic profile information",
      inputSchema: {
        cursor: z.string().optional().describe("Pagination cursor for next page of results"),
        limit: z.number().optional().default(100).describe("Maximum number of users to return (default 100, max 200)"),
      },
    },
    async ({ cursor, limit }) => {
      const response = await slackClient.getUsers(limit, cursor);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  server.registerTool(
    "slack_get_user_profile",
    {
      title: "Get Slack User Profile",
      description: "Get detailed profile information for a specific user",
      inputSchema: {
        user_id: z.string().describe("The ID of the user"),
      },
    },
    async ({ user_id }) => {
      const response = await slackClient.getUserProfile(user_id);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

interface SessionData {
  botToken: string;
  teamId: string;
  channelIds?: string[];
  createdAt: number;
}

const sessions = new Map<string, SessionData>();

function createSession(data: Omit<SessionData, "createdAt">): string {
  const key = "sk_" + randomUUID();
  sessions.set(key, { ...data, createdAt: Date.now() });
  return key;
}

// ---------------------------------------------------------------------------
// extractCredentials middleware — resolves SlackClient from session or headers
// ---------------------------------------------------------------------------

function extractCredentials(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const sessionKey = req.headers["x-session-key"] as string | undefined;
  if (sessionKey) {
    const session = sessions.get(sessionKey);
    if (!session) {
      res.status(401).json({ error: { code: "INVALID_SESSION", message: "Session not found or expired" } });
      return;
    }
    res.locals.slackClient = new SlackClient(session.botToken, session.teamId, session.channelIds);
    return next();
  }

  const authHeader = req.headers.authorization;
  const teamId = req.headers["x-slack-team-id"] as string | undefined;

  if (!authHeader?.startsWith("Bearer ") || !teamId) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Provide Authorization + X-Slack-Team-Id headers, or X-Session-Key" },
    });
    return;
  }

  res.locals.slackClient = new SlackClient(authHeader.substring(7), teamId);
  next();
}

// ---------------------------------------------------------------------------
// HTTP server — REST API only (/api/*, /health)
// ---------------------------------------------------------------------------

const toolMeta = createSlackServer(null as any);

async function runHttpServer(port: number = 3000) {
  const app = express();
  app.use(express.json());

  // GET /api/tools — tool metadata (no auth)
  app.get('/api/tools', (_req, res) => {
    res.json({ tools: toolMeta.listTools() });
  });

  // POST /api/tools/call — execute a tool (auth required)
  app.post('/api/tools/call', extractCredentials, async (req, res) => {
    const { name, arguments: args } = req.body;

    if (!name) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "Tool name required" } });
      return;
    }
    if (!toolMeta.hasTool(name)) {
      res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: `Unknown tool: ${name}` } });
      return;
    }

    try {
      const server = createSlackServer(res.locals.slackClient);
      const result = await server.callTool(name, args ?? {});
      res.json({ result });
    } catch (err: any) {
      if (err.name === 'ZodError') {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: err.message } });
      } else {
        res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
      }
    }
  });

  // POST /api/sessions — create session
  app.post('/api/sessions', (req, res) => {
    const { slack_bot_token, slack_team_id, slack_channel_ids } = req.body;

    if (!slack_bot_token || !slack_team_id) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "slack_bot_token and slack_team_id required" } });
      return;
    }

    const key = createSession({
      botToken: slack_bot_token,
      teamId: slack_team_id,
      channelIds: slack_channel_ids,
    });
    res.status(201).json({ session_key: key });
  });

  // DELETE /api/sessions/:key — delete session
  app.delete('/api/sessions/:key', (req, res) => {
    sessions.delete(req.params.key);
    res.status(204).end();
  });

  // GET /health
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'Slack REST API Server',
      version: '1.0.0'
    });
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.error(`Slack REST API server running on http://0.0.0.0:${port}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs() {
  const args = process.argv.slice(2);
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node index.js [options]

Options:
  --port <number>        Port for HTTP server (default: 3000)
  --help, -h             Show this help message

REST API endpoints:
  GET    /api/tools             List available tools (no auth)
  POST   /api/tools/call        Call a tool (auth required)
  POST   /api/sessions          Create a session
  DELETE /api/sessions/:key     Delete a session
  GET    /health                Health check
`);
      process.exit(0);
    }
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('Error: --port must be a valid port number (1-65535)');
    process.exit(1);
  }

  return { port };
}

export async function main() {
  const { port } = parseArgs();

  let httpServer: any = null;

  const setupGracefulShutdown = () => {
    const shutdown = (signal: string) => {
      console.error(`\nReceived ${signal}. Shutting down gracefully...`);

      if (httpServer) {
        httpServer.close(() => {
          console.error('HTTP server closed.');
          process.exit(0);
        });

        setTimeout(() => {
          console.error('Forcing shutdown...');
          process.exit(1);
        }, 5000);
      } else {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGQUIT', () => shutdown('SIGQUIT'));
  };

  setupGracefulShutdown();
  httpServer = await runHttpServer(port);
}

if (import.meta.url.startsWith('file://')) {
  const currentFile = resolve(fileURLToPath(import.meta.url));
  const executedFile = process.argv[1] ? resolve(process.argv[1]) : '';

  const isTestEnvironment = process.argv.some(arg => arg.includes('jest')) ||
                            process.env.NODE_ENV === 'test' ||
                            process.argv[1]?.includes('jest');

  const hasOurCliFlags = process.argv.includes('--port');
  const isMainModule = !isTestEnvironment && (
    currentFile === executedFile ||
    (process.argv[1] && process.argv[1].includes('slack-mcp')) ||
    (process.argv[0].includes('node') && process.argv[1] && !process.argv[1].includes('test')) ||
    hasOurCliFlags
  );

  if (isMainModule) {
    main().catch((error) => {
      console.error("Fatal error in main():", error);
      process.exit(1);
    });
  }
}
