require("dotenv/config");

const { Readable } = require("node:stream");
const { app } = require("@azure/functions");

const { AzureOpenAI } = require("openai");

const mailer = require("./mailer");

const {
  ASSISTANT_ID,
  AZURE_DEPLOYMENT_NAME,
  EMAIL_RECEIVER,
  OPENAI_FUNCTION_CALLING_SKIP_SEND_EMAIL,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_ENDPOINT,
  OPENAI_API_VERSION
} = process.env;

// Debug all environment variables
console.log("🔍 Environment Variables Check:");
console.log("ASSISTANT_ID:", ASSISTANT_ID ? "✅ SET" : "❌ MISSING");
console.log("AZURE_DEPLOYMENT_NAME:", AZURE_DEPLOYMENT_NAME ? "✅ SET" : "❌ MISSING");
console.log("EMAIL_RECEIVER:", EMAIL_RECEIVER ? "✅ SET" : "❌ MISSING");
console.log("OPENAI_FUNCTION_CALLING_SKIP_SEND_EMAIL:", OPENAI_FUNCTION_CALLING_SKIP_SEND_EMAIL ? "✅ SET" : "❌ MISSING");
console.log("AZURE_OPENAI_API_KEY:", AZURE_OPENAI_API_KEY ? "✅ SET (length: " + AZURE_OPENAI_API_KEY.length + ")" : "❌ MISSING");
console.log("AZURE_OPENAI_ENDPOINT:", AZURE_OPENAI_ENDPOINT ? "✅ SET" : "❌ MISSING");
console.log("OPENAI_API_VERSION:", OPENAI_API_VERSION ? "✅ SET" : "❌ MISSING");

async function initAzureOpenAI(context) {
  console.log("🔧 Starting Azure OpenAI initialization...");
  
  try {
    console.log("🔑 Using API Key authentication...");
    console.log("🌐 Endpoint:", AZURE_OPENAI_ENDPOINT);
    console.log("📋 API Version:", OPENAI_API_VERSION);
    console.log("🔐 API Key prefix:", AZURE_OPENAI_API_KEY ? AZURE_OPENAI_API_KEY.substring(0, 10) + "..." : "MISSING");
    
    const client = new AzureOpenAI({
      apiKey: AZURE_OPENAI_API_KEY,
      endpoint: AZURE_OPENAI_ENDPOINT,
      apiVersion: OPENAI_API_VERSION
    });
    
    console.log("✅ Azure OpenAI client created successfully");
    return client;
    
  } catch (error) {
    console.error("❌ Failed to initialize Azure OpenAI:", error);
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    throw error;
  }
}

const assistantDefinition = {
  name: "Finance Assistant",
  instructions:
    "You are a personal finance assistant. Retrieve the latest closing price of a stock using its ticker symbol. "
    + "You also know how to generate a full body email formatted as rich html. Do not use other format than rich html."
    + "Only use the functions you have been provided with",
  tools: [
    {
      type: "function",
      function: {
        name: "getStockPrice",
        description:
          "Retrieve the latest closing price of a stock using its ticker symbol.",
        parameters: {
          type: "object",
          properties: {
            symbol: {
              type: "string",
              description: "The ticker symbol of the stock",
            },
          },
          required: ["symbol"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "writeAndSendEmail",
        description:
          "Provides an email subject, and body content in plain text, and the same body in html",
        parameters: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description: "The subject of the email. Limit to maximum 50 characters",
            },
            html: {
              type: "string",
              description: "The body text of the email in html",
            },
          },
          required: ["subject", "html"],
        },
      },
    }
  ],
  model: AZURE_DEPLOYMENT_NAME,
};

async function* processQuery(userQuery) {
  console.log("🚀 Starting processQuery with user input:", userQuery);
  
  try {
    console.log("🔧 Step 0: Connect and acquire an OpenAI instance");
    const openai = await initAzureOpenAI();
    console.log("✅ OpenAI client ready");

    console.log("🤖 Step 1: Retrieve or Create an Assistant");
    console.log("Assistant ID from env:", ASSISTANT_ID);
    
    let assistant;
    if (ASSISTANT_ID) {
      console.log("📋 Retrieving existing assistant...");
      assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
      console.log("✅ Assistant retrieved:", assistant.name);
    } else {
      console.log("🆕 Creating new assistant...");
      console.log("Assistant definition:", JSON.stringify(assistantDefinition, null, 2));
      assistant = await openai.beta.assistants.create(assistantDefinition);
      console.log("✅ Assistant created:", assistant.id, assistant.name);
    }

    console.log("🧵 Step 2: Create a Thread");
    const thread = await openai.beta.threads.create();
    console.log("✅ Thread created:", thread.id);

    console.log("💬 Step 3: Add a Message to the Thread");
    const message = await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userQuery,
    });
    console.log("✅ Message added:", message.id);

    console.log("▶️ Step 4: Create a Run (and stream the response)");
    console.log("Using assistant:", assistant.id);
    console.log("Using thread:", thread.id);
    
    const run = openai.beta.threads.runs.stream(thread.id, {
      assistant_id: assistant.id,
      stream: true,
    });
    console.log("✅ Run stream created");

    console.log("📡 Step 5: Read streamed response");
    let eventCount = 0;
    for await (const chunk of run) {
      eventCount++;
      const { event, data } = chunk;

      console.log(`📦 Event ${eventCount}: ${event}`);
      
      if (event === "thread.run.created") {
        yield "@created";
        console.log("✅ Run created, sending status to client");
      }
      else if (event === "thread.run.queued") {
        yield "@queued";
        console.log("⏳ Run queued, sending status to client");
      }
      else if (event === "thread.run.in_progress") {
        yield "@in_progress";
        console.log("🔄 Run in progress, sending status to client");
      }
      else if (event === "thread.message.delta") {
        const delta = data.delta;
        if (delta && delta.content && delta.content[0]) {
          const value = delta.content[0]?.text?.value || "";
          if (value) {
            console.log("💬 Streaming text chunk:", JSON.stringify(value));
            yield value;
          }
        }
      }
      else if (event === "thread.run.failed") {
        console.error("❌ Run failed:", data.last_error);
        const value = data.last_error.message;
        yield `Error: ${value}`;
      }
      else if (event === "thread.run.requires_action") {
        console.log("🔧 Run requires action (function calling)");
        yield* handleRequiresAction(openai, data, data.id, data.thread_id);
      }
      else if (event === "thread.run.completed") {
        console.log("✅ Run completed successfully");
      }
      else {
        console.log("🔍 Other event:", event, "Data keys:", Object.keys(data));
      }
    }

    console.log(`🎉 Processing complete! Handled ${eventCount} events`);

  } catch (error) {
    console.error("💥 Fatal error in processQuery:", error);
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    yield `Error: ${error.message}`;
  }
}

async function* handleRequiresAction(openai, run, runId, threadId) {
  console.log("🛠️ Handle Function Calling");
  console.log("Required actions:", run.required_action?.submit_tool_outputs?.tool_calls?.length || 0);
  
  try {
    const toolCalls = run.required_action.submit_tool_outputs.tool_calls;
    console.log("Tool calls:", toolCalls.map(tc => tc.function.name));
    
    const toolOutputs = await Promise.all(
      toolCalls.map(async (toolCall) => {
        console.log(`🔧 Processing tool call: ${toolCall.function.name}`);
        console.log("Arguments:", toolCall.function.arguments);
        
        if (toolCall.function.name === "getStockPrice") {
          const symbol = JSON.parse(toolCall.function.arguments).symbol;
          console.log(`📈 Getting stock price for: ${symbol}`);
          const price = await getStockPrice(symbol);
          console.log(`💰 Stock price result: ${price}`);
          return {
            tool_call_id: toolCall.id,
            output: price,
          };
        } else if (toolCall.function.name === "writeAndSendEmail") {
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`📧 Writing email with subject: ${args.subject}`);
          const result = await writeAndSendEmail(args.subject, args.html);
          console.log(`✉️ Email result: ${result}`);
          return {
            tool_call_id: toolCall.id,
            output: result,
          };
        } else {
          console.log(`❓ Unknown tool call: ${toolCall.function.name}`);
          return {
            tool_call_id: toolCall.id,
            output: "Unknown function",
          };
        }
      })
    );

    console.log("🔄 Submitting tool outputs...");
    yield* submitToolOutputs(openai, toolOutputs, runId, threadId);
    
  } catch (error) {
    console.error("💥 Error processing required action:", error);
    yield `Function call error: ${error.message}`;
  }
}

async function* submitToolOutputs(openai, toolOutputs, runId, threadId) {
  try {
    console.log("📤 Submitting tool outputs and streaming response");
    console.log("Tool outputs count:", toolOutputs.length);
    
    const asyncStream = openai.beta.threads.runs.submitToolOutputsStream(
      threadId,
      runId,
      { tool_outputs: toolOutputs }
    );
    
    let outputEventCount = 0;
    for await (const chunk of asyncStream) {
      outputEventCount++;
      const { event, data } = chunk;
      
      console.log(`📦 Tool output event ${outputEventCount}: ${event}`);
      
      if (event === "thread.message.delta") {
        const { delta } = data;
        if (delta && delta.content && delta.content[0]) {
          const value = delta.content[0]?.text?.value || "";
          if (value) {
            console.log("💬 Tool output text chunk:", JSON.stringify(value));
            yield value;
          }
        }
      }
      else if (event === "thread.run.completed") {
        console.log("✅ Tool output processing completed");
      }
    }
    
    console.log(`🎉 Tool output processing complete! Handled ${outputEventCount} events`);
    
  } catch (error) {
    console.error("💥 Error submitting tool outputs:", error);
    yield `Tool submission error: ${error.message}`;
  }
}

// Function implementations
async function getStockPrice(symbol) {
  console.log(`📊 Mock: Getting stock price for ${symbol}`);
  const price = Math.random() * 1000;
  console.log(`💵 Mock price generated: $${price.toFixed(2)}`);
  return `$${price.toFixed(2)}`;
}

async function writeAndSendEmail(subject, html) {
  console.log(`📧 Email function called with subject: "${subject}"`);
  console.log(`📄 HTML length: ${html.length} characters`);
  
  if (OPENAI_FUNCTION_CALLING_SKIP_SEND_EMAIL === 'true') {
    console.log('🚫 Dry mode enabled. Skip sending emails');
    return 'Fake email sent successfully!';
  }

  try {
    console.log(`📮 Attempting to send real email to: ${EMAIL_RECEIVER}`);
    const info = await mailer.sendEmail({
      to: EMAIL_RECEIVER, 
      subject, 
      html
    });
    console.log(`✅ Email sent successfully: ${info.messageId}`);
    return info.messageId;
  } catch (error) {
    console.error(`❌ Email sending failed:`, error);
    return `Email failed: ${error.message}`;
  }
}

// API definition
console.log("🌐 Setting up HTTP function...");
app.setup({ enableHttpStream: true });

app.http("assistant", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request) => {
    console.log("🌍 HTTP Request received!");
    console.log(`📍 URL: ${request.url}`);
    console.log(`🔧 Method: ${request.method}`);
    console.log(`📋 Headers:`, Object.keys(request.headers));
    
    try {
      const query = await request.text();
      console.log(`💬 User query received: "${query}"`);
      console.log(`📏 Query length: ${query.length} characters`);
      
      if (!query || query.trim() === '') {
        console.log("⚠️ Empty query received");
        return {
          status: 400,
          body: "Empty query not allowed"
        };
      }
      
      console.log("🚀 Starting query processing...");
      
      return {
        headers: {
          'Content-Type': 'text/plain',
          "Transfer-Encoding": "chunked"
        }, 
        body: Readable.from(processQuery(query))
      };
      
    } catch (error) {
      console.error("💥 Request handler error:", error);
      return {
        status: 500,
        body: `Request error: ${error.message}`
      };
    }
  },
});

console.log("✅ Assistant function setup complete!");
