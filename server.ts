import express from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { getCodexTokens, hasCodexAuth } from './openai-oauth.js';

// ============================================
// Configuration
// ============================================

const PORT = parseInt(process.env.LETTA_LOCAL_PORT || '8990', 10);
const DATA_DIR = path.resolve(process.env.LETTA_LOCAL_DATA_DIR || './data');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.LETTA_LOCAL_MODEL || 'qwen/qwen3-235b-a22b-2507';
const CODEX_MODEL = process.env.LETTA_CODEX_MODEL || 'gpt-5.4';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses';
const USE_CODEX = process.env.LETTA_USE_CODEX === '1' || hasCodexAuth();
const GIT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const AGENT_FILE = path.join(DATA_DIR, 'agent.json');
const BLOCKS_FILE = path.join(DATA_DIR, 'blocks.json');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');

// ============================================
// Helpers
// ============================================

function uuid(prefix: string = ''): string {
  return prefix + crypto.randomUUID();
}

function ensureDataDirs(): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

function readJSON(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJSON(filePath: string, data: any): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function labelFromPath(p: string): string {
  // "/memories/user_preferences" -> "user_preferences"
  return p.split('/').filter(Boolean).pop() || p;
}

// ============================================
// Data Access
// ============================================

interface Block {
  label: string;
  value: string;
  description: string;
  limit: number;
}

interface AgentData {
  id: string;
  name: string;
  description: string;
  system: string;
  llm_config: any;
}

interface ConversationMessage {
  id: string;
  message_type: string; // user_message, assistant_message, tool_call, tool_return
  role?: string;
  content?: string;
  date: string;
}

function loadAgent(): AgentData | null {
  return readJSON(AGENT_FILE);
}

function saveAgent(agent: AgentData): void {
  writeJSON(AGENT_FILE, agent);
}

function loadBlocks(): Record<string, Block> {
  return readJSON(BLOCKS_FILE) || {};
}

function saveBlocks(blocks: Record<string, Block>): void {
  writeJSON(BLOCKS_FILE, blocks);
}

function convPath(convId: string): string {
  // Sanitize to prevent path traversal
  const sanitized = convId.replace(/[^a-zA-Z0-9\-]/g, '');
  return path.join(CONVERSATIONS_DIR, `${sanitized}.json`);
}

function loadConversation(convId: string): ConversationMessage[] {
  return readJSON(convPath(convId)) || [];
}

function saveConversation(convId: string, messages: ConversationMessage[]): void {
  writeJSON(convPath(convId), messages);
}

// ============================================
// System Prompt Builder
// ============================================

function buildSystemPrompt(agent: AgentData, blocks: Record<string, Block>): string {
  const blockEntries = Object.values(blocks).map(b => {
    const charsCurrentLine = `- chars_current=${(b.value || '').length}`;
    const charsLimitLine = `- chars_limit=${b.limit}`;
    return `<${b.label}>
<description>
${b.description}
</description>
<metadata>
${charsCurrentLine}
${charsLimitLine}
</metadata>
<value>
${b.value}
</value>
</${b.label}>`;
  }).join('\n\n');

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const modifiedStr = now.toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC+0000');

  return `${agent.system}

<memory_blocks>
The following memory blocks are currently engaged in your core memory unit:

${blockEntries}

</memory_blocks>

<memory_metadata>
- The current system date is: ${dateStr}
- Memory blocks were last modified: ${modifiedStr}
</memory_metadata>`;
}

// ============================================
// Tool Definitions (OpenAI-compatible format)
// ============================================

const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'memory',
      description: 'Memory management tool with sub-commands: create, str_replace, insert, delete, rename.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Sub-command: create, str_replace, insert, delete, rename' },
          path: { type: 'string', description: 'Path to the memory block, e.g. /memories/label' },
          file_text: { type: 'string', description: 'Initial value for create' },
          description: { type: 'string', description: 'Description for create/rename' },
          old_string: { type: 'string', description: 'Text to replace (str_replace)' },
          new_string: { type: 'string', description: 'Replacement text (str_replace)' },
          insert_line: { type: 'integer', description: 'Line number to insert at (insert)' },
          insert_text: { type: 'string', description: 'Text to insert (insert)' },
          old_path: { type: 'string', description: 'Old path for rename' },
          new_path: { type: 'string', description: 'New path for rename' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_rethink',
      description: 'Completely rewrite the contents of a memory block. Use for large sweeping changes.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The memory block label to rewrite' },
          new_memory: { type: 'string', description: 'The new memory contents' },
        },
        required: ['label', 'new_memory'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_replace',
      description: 'Replace a specific string in a memory block with a new string.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The memory block label' },
          old_str: { type: 'string', description: 'Text to replace (must match exactly)' },
          new_str: { type: 'string', description: 'Replacement text' },
        },
        required: ['label', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'memory_insert',
      description: 'Insert text at a specific line in a memory block. Defaults to end of block.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The memory block label' },
          new_str: { type: 'string', description: 'Text to insert' },
          insert_line: { type: 'integer', description: 'Line number to insert after (0=beginning, -1=end). Default: -1' },
        },
        required: ['label', 'new_str'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'conversation_search',
      description: 'Search prior conversation history using text matching.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          roles: { type: 'array', items: { type: 'string' }, description: 'Filter by roles' },
          limit: { type: 'integer', description: 'Max results' },
          start_date: { type: 'string', description: 'Start date filter (ISO 8601)' },
          end_date: { type: 'string', description: 'End date filter (ISO 8601)' },
        },
        required: [],
      },
    },
  },
];

// ============================================
// Tool Execution
// ============================================

function executeTool(name: string, args: any, blocks: Record<string, Block>): string {
  try {
    switch (name) {
      case 'memory':
        return executeMemory(args, blocks);
      case 'memory_rethink':
        return executeMemoryRethink(args, blocks);
      case 'memory_replace':
        return executeMemoryReplace(args, blocks);
      case 'memory_insert':
        return executeMemoryInsert(args, blocks);
      case 'conversation_search':
        return executeConversationSearch(args);
      case 'web_search':
      case 'fetch_webpage':
        return 'Tool not available in local mode.';
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

function executeMemory(args: any, blocks: Record<string, Block>): string {
  const { command, path: memPath, file_text, description, old_string, new_string, insert_line, insert_text, old_path, new_path } = args;
  switch (command) {
    case 'create': {
      const label = labelFromPath(memPath || new_path || '');
      if (!label) return 'Error: path required for create';
      blocks[label] = { label, value: file_text || '', description: description || '', limit: 20000 };
      saveBlocks(blocks);
      return `Created memory block: ${label}`;
    }
    case 'str_replace': {
      const label = labelFromPath(memPath || '');
      const block = blocks[label];
      if (!block) return `Error: block "${label}" not found`;
      if (!block.value.includes(old_string)) return `Error: old_string not found in block "${label}"`;
      block.value = block.value.replace(old_string, new_string || '');
      saveBlocks(blocks);
      return `Replaced text in block: ${label}`;
    }
    case 'insert': {
      const label = labelFromPath(memPath || '');
      const block = blocks[label];
      if (!block) return `Error: block "${label}" not found`;
      const lines = block.value.split('\n');
      const lineNum = insert_line ?? lines.length;
      lines.splice(lineNum, 0, insert_text || '');
      block.value = lines.join('\n');
      saveBlocks(blocks);
      return `Inserted text at line ${lineNum} in block: ${label}`;
    }
    case 'delete': {
      const label = labelFromPath(memPath || '');
      if (!blocks[label]) return `Error: block "${label}" not found`;
      delete blocks[label];
      saveBlocks(blocks);
      return `Deleted memory block: ${label}`;
    }
    case 'rename': {
      if (old_path && new_path) {
        const oldLabel = labelFromPath(old_path);
        const newLabel = labelFromPath(new_path);
        const block = blocks[oldLabel];
        if (!block) return `Error: block "${oldLabel}" not found`;
        delete blocks[oldLabel];
        block.label = newLabel;
        blocks[newLabel] = block;
      }
      if (memPath && description !== undefined) {
        const label = labelFromPath(memPath);
        if (blocks[label]) blocks[label].description = description;
      }
      saveBlocks(blocks);
      return 'Rename completed';
    }
    default:
      return `Unknown memory command: ${command}`;
  }
}

function executeMemoryRethink(args: any, blocks: Record<string, Block>): string {
  const { label, new_memory } = args;
  if (!blocks[label]) return `Error: block "${label}" not found`;
  blocks[label].value = new_memory;
  saveBlocks(blocks);
  return `Rewrote memory block: ${label}`;
}

function executeMemoryReplace(args: any, blocks: Record<string, Block>): string {
  const { label, old_str, new_str } = args;
  if (!blocks[label]) return `Error: block "${label}" not found`;
  if (!blocks[label].value.includes(old_str)) return `Error: old_str not found in block "${label}"`;
  blocks[label].value = blocks[label].value.replace(old_str, new_str);
  saveBlocks(blocks);
  return `Replaced text in block: ${label}`;
}

function executeMemoryInsert(args: any, blocks: Record<string, Block>): string {
  const { label, new_str, insert_line } = args;
  if (!blocks[label]) return `Error: block "${label}" not found`;
  const lines = blocks[label].value.split('\n');
  const lineNum = (insert_line === undefined || insert_line === -1) ? lines.length : insert_line;
  lines.splice(lineNum, 0, new_str);
  blocks[label].value = lines.join('\n');
  saveBlocks(blocks);
  return `Inserted text in block: ${label}`;
}

function executeConversationSearch(args: any): string {
  const { query, roles, limit, start_date, end_date } = args;
  const maxResults = limit || 20;
  const results: Array<{ date: string; role: string; content: string }> = [];

  // Search all conversation files
  const convFiles = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of convFiles) {
    const messages: ConversationMessage[] = readJSON(path.join(CONVERSATIONS_DIR, file)) || [];
    for (const msg of messages) {
      if (roles && roles.length > 0) {
        const msgRole = msg.message_type === 'user_message' ? 'user' : msg.message_type === 'assistant_message' ? 'assistant' : 'tool';
        if (!roles.includes(msgRole)) continue;
      }
      if (start_date && msg.date < start_date) continue;
      if (end_date && msg.date > end_date + 'T23:59:59') continue;
      if (query && msg.content && !msg.content.toLowerCase().includes(query.toLowerCase())) continue;
      if (msg.content) {
        results.push({ date: msg.date, role: msg.message_type, content: msg.content.substring(0, 500) });
      }
      if (results.length >= maxResults) break;
    }
    if (results.length >= maxResults) break;
  }

  if (results.length === 0) return 'No matching messages found.';
  return results.map(r => `[${r.date}] (${r.role}) ${r.content}`).join('\n\n');
}

// ============================================
// LLM Interaction (Codex Backend or OpenRouter)
// ============================================

const conversationLocks = new Map<string, boolean>();

// Convert chat-completions messages to Codex Responses API format
function convertToResponsesInput(
  messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }>
): { instructions: string; input: any[] } {
  let instructions = '';
  const input: any[] = [];
  let msgIdx = 0;

  for (const msg of messages) {
    if (msg.role === 'system') {
      instructions = msg.content || '';
      continue;
    }

    if (msg.role === 'user') {
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text: msg.content || '' }],
      });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with tool calls
        if (msg.content) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: msg.content, annotations: [] }],
            status: 'completed',
            id: `msg_${msgIdx}`,
          });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            id: `fc_${msgIdx}_${tc.id}`.slice(0, 64),
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content || '', annotations: [] }],
          status: 'completed',
          id: `msg_${msgIdx}`,
        });
      }
    } else if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: msg.content || '',
      });
    }
    msgIdx++;
  }

  return { instructions, input };
}

// Convert Codex Responses API tools format
function convertToolsForResponses(tools: any[]): any[] {
  return tools.map(t => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

// Parse SSE stream from Codex and extract final result
async function parseCodexSSE(response: Response): Promise<{
  content: string;
  tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
}> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let currentToolCallId = '';
  let currentToolName = '';
  let currentToolArgs = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');

    while (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const dataLines = chunk
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);

          if (event.type === 'response.output_text.delta') {
            content += event.delta || '';
          } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            currentToolCallId = event.item.call_id || '';
            currentToolName = event.item.name || '';
            currentToolArgs = '';
          } else if (event.type === 'response.function_call_arguments.delta') {
            currentToolArgs += event.delta || '';
          } else if (event.type === 'response.function_call_arguments.done') {
            currentToolArgs = event.arguments || currentToolArgs;
          } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
            toolCalls.push({
              id: event.item.call_id || currentToolCallId,
              name: event.item.name || currentToolName,
              arguments: event.item.arguments || currentToolArgs,
            });
            currentToolCallId = '';
            currentToolName = '';
            currentToolArgs = '';
          } else if (event.type === 'error') {
            throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
          } else if (event.type === 'response.failed') {
            const msg = event.response?.error?.message;
            throw new Error(msg || 'Codex response failed');
          }
        } catch (e: any) {
          if (e.message?.startsWith('Codex error:') || e.message === 'Codex response failed') throw e;
          // JSON parse error — skip
        }
      }

      idx = buffer.indexOf('\n\n');
    }
  }

  return {
    content,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      function: { name: tc.name, arguments: tc.arguments },
    })),
  };
}

async function callLLM(messages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }>, tools: any[]): Promise<any> {
  if (USE_CODEX) {
    const tokens = await getCodexTokens();
    const { instructions, input } = convertToResponsesInput(messages);

    const body: any = {
      model: CODEX_MODEL,
      store: false,
      stream: true,
      instructions,
      input,
      tool_choice: 'auto',
    };

    if (tools && tools.length > 0) {
      body.tools = convertToolsForResponses(tools);
    }

    console.log(`  [codex] Calling ${CODEX_BASE_URL} with model=${CODEX_MODEL}, input_items=${input.length}`);

    const response = await fetch(CODEX_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex error (${response.status}): ${errorText}`);
    }

    // Parse SSE stream and convert to chat-completions-like format
    const result = await parseCodexSSE(response);

    const message: any = { content: result.content || null };
    if (result.tool_calls.length > 0) {
      message.tool_calls = result.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: tc.function,
      }));
    }

    return {
      choices: [{
        message,
        finish_reason: result.tool_calls.length > 0 ? 'tool_calls' : 'stop',
      }],
    };
  }

  // Fallback: OpenRouter
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function processMessage(
  convId: string,
  userMessage: string,
  agent: AgentData,
  res: express.Response
): Promise<void> {
  const blocks = loadBlocks();
  const convMessages = loadConversation(convId);

  // Store user message
  const userMsg: ConversationMessage = {
    id: uuid('message-'),
    message_type: 'user_message',
    role: 'user',
    content: userMessage,
    date: new Date().toISOString(),
  };
  convMessages.push(userMsg);
  saveConversation(convId, convMessages);

  // Build LLM messages
  const llmMessages: Array<{ role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string }> = [
    { role: 'system', content: buildSystemPrompt(agent, blocks) },
  ];

  // Add recent conversation history (last 20 messages to stay within context)
  const recentMessages = convMessages.slice(-20);
  for (const msg of recentMessages) {
    if (msg.message_type === 'user_message') {
      llmMessages.push({ role: 'user', content: msg.content || '' });
    } else if (msg.message_type === 'assistant_message') {
      llmMessages.push({ role: 'assistant', content: msg.content || '' });
    }
  }

  // Tool calling loop (max 10 iterations)
  for (let i = 0; i < 10; i++) {
    const result = await callLLM(llmMessages, TOOL_DEFINITIONS);
    const choice = result.choices?.[0];
    if (!choice) throw new Error('No response from LLM');

    const message = choice.message;
    console.log(`  [llm] finish_reason=${choice.finish_reason}, tool_calls=${message.tool_calls?.length || 0}, content_len=${(message.content || '').length}`);
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        console.log(`  [llm] tool: ${tc.function.name}(${tc.function.arguments.substring(0, 120)})`);
      }
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      // Add assistant message with tool calls
      llmMessages.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.tool_calls,
      });

      // Execute each tool call
      for (const tc of message.tool_calls) {
        const toolName = tc.function.name;
        let toolArgs: any;
        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          toolArgs = {};
        }

        console.log(`  Tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 100)}...)`);
        const toolResult = executeTool(toolName, toolArgs, blocks);
        console.log(`  Tool result: ${toolResult.substring(0, 100)}`);

        // Add tool result
        llmMessages.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: tc.id,
        });

        // SSE event for tool activity
        res.write(`data: ${JSON.stringify({ message_type: 'tool_call', tool_call: { name: toolName } })}\n\n`);
      }

      // Rebuild system prompt (blocks may have changed)
      llmMessages[0] = { role: 'system', content: buildSystemPrompt(agent, blocks) };
      continue;
    }

    // Final text response
    const assistantContent = message.content || '';
    const assistantMsg: ConversationMessage = {
      id: uuid('message-'),
      message_type: 'assistant_message',
      role: 'assistant',
      content: assistantContent,
      date: new Date().toISOString(),
    };
    convMessages.push(assistantMsg);
    saveConversation(convId, convMessages);

    // SSE event
    res.write(`data: ${JSON.stringify({
      message_type: 'assistant_message',
      id: assistantMsg.id,
      content: assistantContent,
      date: assistantMsg.date,
    })}\n\n`);
    break;
  }

  res.write('data: [DONE]\n\n');
}

// ============================================
// Git Sync
// ============================================

function gitExec(cmd: string): string {
  try {
    return execSync(cmd, { cwd: DATA_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    console.error(`Git error: ${err.message}`);
    return '';
  }
}

function isGitRepo(): boolean {
  return fs.existsSync(path.join(DATA_DIR, '.git'));
}

function gitHasChanges(): boolean {
  if (!isGitRepo()) return false;
  const status = gitExec('git status --porcelain');
  return status.length > 0;
}

function gitHasRemote(): boolean {
  if (!isGitRepo()) return false;
  const remote = gitExec('git remote');
  return remote.length > 0;
}

function gitCommitAndPush(): void {
  if (!isGitRepo() || !gitHasChanges()) return;
  const timestamp = new Date().toISOString();
  gitExec('git add -A');
  gitExec(`git commit -m "auto-sync: ${timestamp}"`);
  if (gitHasRemote()) {
    console.log('[git] Pushing changes...');
    gitExec('git push');
    console.log('[git] Push complete');
  }
}

function gitPull(): void {
  if (!isGitRepo() || !gitHasRemote()) return;
  console.log('[git] Pulling latest...');
  gitExec('git pull --rebase');
  console.log('[git] Pull complete');
}

function startGitSyncTimer(): NodeJS.Timeout | null {
  if (!isGitRepo()) {
    console.log('[git] Not a git repo, skipping periodic sync');
    return null;
  }
  console.log(`[git] Periodic sync every ${GIT_SYNC_INTERVAL_MS / 1000}s`);
  return setInterval(() => {
    if (gitHasChanges()) {
      console.log('[git] Periodic sync: changes detected');
      gitCommitAndPush();
    }
  }, GIT_SYNC_INTERVAL_MS);
}

// ============================================
// Express Server
// ============================================

const app = express();
app.use(express.json({ limit: '10mb' }));
const upload = multer({ storage: multer.memoryStorage() });

// --- POST /v1/agents/import ---
app.post('/v1/agents/import', upload.single('file'), (req, res) => {
  try {
    const fileBuffer = req.file?.buffer;
    if (!fileBuffer) return res.status(400).json({ error: 'No file uploaded' });

    const af = JSON.parse(fileBuffer.toString('utf-8'));
    const agentDef = af.agents?.[0];
    if (!agentDef) return res.status(400).json({ error: 'No agent found in .af file' });

    const agentId = uuid('agent-');

    // Save agent
    const agent: AgentData = {
      id: agentId,
      name: agentDef.name || 'Subconscious',
      description: agentDef.description || '',
      system: agentDef.system || '',
      llm_config: agentDef.llm_config || {},
    };
    saveAgent(agent);

    // Save blocks
    const blocks: Record<string, Block> = {};
    for (const b of af.blocks || []) {
      blocks[b.label] = {
        label: b.label,
        value: b.value || '',
        description: b.description || '',
        limit: b.limit || 20000,
      };
    }
    saveBlocks(blocks);

    console.log(`[import] Agent "${agent.name}" imported with ${Object.keys(blocks).length} blocks`);
    res.json({ agent_ids: [agentId] });
  } catch (err: any) {
    console.error('[import] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- GET /v1/agents/:id ---
app.get('/v1/agents/:id', (req, res) => {
  const agent = loadAgent();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const includeBlocks = req.query.include?.toString().includes('agent.blocks');
  const response: any = { ...agent };
  if (includeBlocks) {
    response.blocks = Object.values(loadBlocks());
  }
  res.json(response);
});

// --- PATCH /v1/agents/:id ---
app.patch('/v1/agents/:id', (req, res) => {
  const agent = loadAgent();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  if (req.body.name) agent.name = req.body.name;
  if (req.body.llm_config) agent.llm_config = { ...agent.llm_config, ...req.body.llm_config };

  saveAgent(agent);
  res.json(agent);
});

// --- GET /v1/models/ ---
app.get('/v1/models/', (_req, res) => {
  const activeModel = USE_CODEX ? CODEX_MODEL : DEFAULT_MODEL;
  const provider = USE_CODEX ? 'codex' : 'openrouter';
  res.json([
    {
      model: activeModel.split('/').pop(),
      name: activeModel,
      provider_type: provider,
      handle: activeModel,
    },
  ]);
});

// --- POST /v1/conversations ---
app.post('/v1/conversations', (req, res) => {
  const agentId = req.query.agent_id as string;
  const convId = uuid('conversation-');
  saveConversation(convId, []);
  console.log(`[conv] Created conversation ${convId} for agent ${agentId}`);
  res.json({
    id: convId,
    agent_id: agentId || '',
    created_at: new Date().toISOString(),
  });
});

// --- GET /v1/conversations/:id/messages ---
app.get('/v1/conversations/:id/messages', (req, res) => {
  const convId = req.params.id;
  const limit = parseInt(req.query.limit as string) || 300;
  const messages = loadConversation(convId);
  res.json(messages.slice(-limit));
});

// --- POST /v1/conversations/:id/messages ---
app.post('/v1/conversations/:id/messages', async (req, res) => {
  const convId = req.params.id;

  // Conversation lock
  if (conversationLocks.get(convId)) {
    return res.status(409).json({ error: 'Conversation is busy' });
  }
  conversationLocks.set(convId, true);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Send headers immediately so clients can start reading

  const agent = loadAgent();
  if (!agent) {
    conversationLocks.delete(convId);
    res.write(`data: ${JSON.stringify({ error: 'Agent not found' })}\n\n`);
    res.end();
    return;
  }

  const userContent = req.body.messages?.[0]?.content || '';

  try {
    console.log(`[msg] Processing message for conversation ${convId} (${userContent.length} chars)`);
    await processMessage(convId, userContent, agent, res);
  } catch (err: any) {
    console.error(`[msg] Error: ${err.message}`);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    conversationLocks.delete(convId);
    res.end();
  }
});

// ============================================
// Startup
// ============================================

ensureDataDirs();

// Git: pull on startup, push any uncommitted changes
if (isGitRepo()) {
  gitPull();
  if (gitHasChanges()) {
    console.log('[git] Startup: pushing uncommitted changes from previous session');
    gitCommitAndPush();
  }
}

const syncTimer = startGitSyncTimer();

// Graceful shutdown
function shutdown(): void {
  console.log('\n[shutdown] Saving and syncing...');
  if (syncTimer) clearInterval(syncTimer);
  if (isGitRepo() && gitHasChanges()) {
    gitCommitAndPush();
  }
  console.log('[shutdown] Done');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => {
  const activeModel = USE_CODEX ? CODEX_MODEL : DEFAULT_MODEL;
  const backend = USE_CODEX ? `Codex (chatgpt.com)` : 'OpenRouter';
  console.log(`\n  letta-local server running on http://localhost:${PORT}`);
  console.log(`  Backend: ${backend}`);
  console.log(`  Model: ${activeModel}`);
  console.log(`  Data:  ${DATA_DIR}`);
  console.log(`  Git:   ${isGitRepo() ? 'enabled' : 'not initialized'}\n`);
});
