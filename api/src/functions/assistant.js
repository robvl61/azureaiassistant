require("dotenv/config");

const { Readable } = require("node:stream");
const { app } = require("@azure/functions");
const { AzureOpenAI } = require("openai");

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
console.log("AZURE_OPENAI_API_KEY:", AZURE_OPENAI_API_KEY ? "✅ SET (length: " + AZURE_OPENAI_API_KEY.length + ")" : "❌ MISSING");
console.log("AZURE_OPENAI_ENDPOINT:", AZURE_OPENAI_ENDPOINT ? "✅ SET" : "❌ MISSING");
console.log("OPENAI_API_VERSION:", OPENAI_API_VERSION ? "✅ SET" : "❌ MISSING");

async function initAzureOpenAI() {
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
    throw error;
  }
}

async function* processMessageWithFiles(message, fileIds = [], threadId = null) {
  console.log("🚀 Starting processMessageWithFiles");
  console.log("💬 Message:", message);
  console.log("📎 File IDs:", fileIds);
  console.log("🧵 Thread ID:", threadId);
  
  try {
    console.log("🔧 Step 0: Connect to Azure OpenAI");
    const openai = await initAzureOpenAI();

    console.log("🤖 Step 1: Get Assistant");
    if (!ASSISTANT_ID) {
      throw new Error("ASSISTANT_ID environment variable is required");
    }
    
    const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
    console.log("✅ Assistant retrieved:", assistant.name);

    console.log("🧵 Step 2: Handle Thread");
    let thread;
    if (threadId) {
      console.log("📋 Using existing thread:", threadId);
      try {
        thread = await openai.beta.threads.retrieve(threadId);
        console.log("✅ Existing thread found");
      } catch (error) {
        console.log("⚠️ Existing thread not found, creating new one");
        thread = await openai.beta.threads.create();
        console.log("✅ New thread created:", thread.id);
      }
    } else {
      console.log("🆕 Creating new thread");
      thread = await openai.beta.threads.create();
      console.log("✅ Thread created:", thread.id);
    }

    console.log("💬 Step 3: Add Message to Thread");
    const messageParams = {
      role: "user",
      content: message
    };

    // Add file attachments if provided
    if (fileIds && fileIds.length > 0) {
      console.log("📎 Adding file attachments:", fileIds.length);
      messageParams.attachments = fileIds.map(fileId => ({
        file_id: fileId,
        tools: [{ type: "file_search" }]
      }));
      console.log("✅ File attachments configured");
    }

    const threadMessage = await openai.beta.threads.messages.create(thread.id, messageParams);
    console.log("✅ Message added to thread:", threadMessage.id);

    console.log("▶️ Step 4: Create and Stream Run");
    const run = openai.beta.threads.runs.stream(thread.id, {
      assistant_id: assistant.id,
      stream: true,
    });

    // Yield thread ID for client to store
    yield `@thread:${thread.id}`;
    console.log("📡 Thread ID sent to client");

    console.log("📡 Step 5: Process Streaming Response");
    let eventCount = 0;
    for await (const chunk of run) {
      eventCount++;
      const { event, data } = chunk;

      console.log(`📦 Event ${eventCount}: ${event}`);
      
      if (event === "thread.run.created") {
        yield "@created";
        console.log("✅ Run created");
      }
      else if (event === "thread.run.queued") {
        yield "@queued";
        console.log("⏳ Run queued");
      }
      else if (event === "thread.run.in_progress") {
        yield "@in_progress";
        console.log("🔄 Run in progress");
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
      else if (event === "thread.run.completed") {
        console.log("✅ Run completed successfully");
      }
      else if (event === "thread.run.requires_action") {
        console.log("🔧 Run requires action (function calling)");
        // Handle function calling if needed
        console.log("⚠️ Function calling not implemented in this version");
      }
      else {
        console.log("🔍 Other event:", event);
      }
    }

    console.log(`🎉 Processing complete! Handled ${eventCount} events`);

  } catch (error) {
    console.error("💥 Fatal error in processMessageWithFiles:", error);
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
    yield `Error: ${error.message}`;
  }
}

// API definition with updated handler
console.log("🌐 Setting up HTTP function...");
app.setup({ enableHttpStream: true });

app.http("assistant", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request) => {
    console.log("🌍 HTTP Request received!");
    console.log(`📍 URL: ${request.url}`);
    console.log(`🔧 Method: ${request.method}`);
    
    // CORS headers voor alle responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Thread-ID",
      "Access-Control-Max-Age": "86400"
    };
    
    // Handle OPTIONS preflight request
    if (request.method === "OPTIONS") {
      console.log("🔧 Handling CORS preflight request");
      return {
        status: 200,
        headers: corsHeaders,
        body: ""
      };
    }
    
    try {
      // Parse request body as JSON
      let requestData;
      const contentType = request.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        console.log("📋 Parsing JSON request body");
        requestData = await request.json();
      } else {
        console.log("📋 Parsing text request body (legacy mode)");
        const text = await request.text();
        requestData = { message: text, fileIds: [] };
      }
      
      const { message, fileIds = [] } = requestData;
      const threadId = request.headers.get('x-thread-id') || null;
      
      console.log(`💬 Message received: "${message}"`);
      console.log(`📎 File IDs: [${fileIds.join(', ')}]`);
      console.log(`🧵 Thread ID from header: ${threadId}`);
      console.log(`📏 Message length: ${message ? message.length : 0} characters`);
      
      if (!message || message.trim() === '') {
        console.log("⚠️ Empty message received");
        return {
          status: 400,
          headers: corsHeaders,
          body: "Message is required"
        };
      }
      
      console.log("🚀 Starting message processing...");
      
      return {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/plain',
          "Transfer-Encoding": "chunked"
        }, 
        body: Readable.from(processMessageWithFiles(message, fileIds, threadId))
      };
      
    } catch (error) {
      console.error("💥 Request handler error:", error);
      return {
        status: 500,
        headers: corsHeaders,
        body: `Request error: ${error.message}`
      };
    }
  },
});

// Upload endpoint for file management
app.http("upload", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request) => {
    console.log("📤 Upload request received!");
    console.log(`📍 URL: ${request.url}`);
    console.log(`🔧 Method: ${request.method}`);
    
    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400"
    };
    
    // Handle OPTIONS preflight request
    if (request.method === "OPTIONS") {
      console.log("🔧 Handling CORS preflight for upload");
      return {
        status: 200,
        headers: corsHeaders,
        body: ""
      };
    }
    
    try {
      console.log("📋 Processing file upload...");
      
      // Get FormData from request
      const formData = await request.formData();
      const file = formData.get('file');
      const fileName = formData.get('fileName') || file?.name || 'uploaded-file';
      const fileSize = formData.get('fileSize') || file?.size || 0;
      
      console.log(`📁 File name: ${fileName}`);
      console.log(`📏 File size: ${fileSize} bytes`);
      
      if (!file) {
        console.log("❌ No file provided");
        return {
          status: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "No file provided" })
        };
      }
      
      console.log("🔧 Initializing Azure OpenAI for upload...");
      const openai = await initAzureOpenAI();
      
      console.log("📤 Uploading file to Azure OpenAI...");
      
      // Convert file to proper format for Azure OpenAI
      const fileBuffer = Buffer.from(await file.arrayBuffer());
      
      // Create a File-like object that Azure OpenAI expects
      const fileForUpload = new File([fileBuffer], fileName, {
        type: file.type || 'application/octet-stream'
      });
      
      console.log(`🔍 File details for upload:`, {
        name: fileForUpload.name,
        size: fileForUpload.size,
        type: fileForUpload.type
      });
      
      // Upload file to Azure OpenAI
      const uploadedFile = await openai.files.create({
        file: fileForUpload,
        purpose: "assistants"
      });
      
      console.log("✅ File uploaded successfully!");
      console.log(`🆔 File ID: ${uploadedFile.id}`);
      
      // Add file to vector store (if you have one configured)
      if (ASSISTANT_ID) {
        try {
          console.log("🔗 Adding file to assistant vector store...");
          const assistant = await openai.beta.assistants.retrieve(ASSISTANT_ID);
          
          // Get the vector store ID from assistant
          const vectorStoreId = assistant.tool_resources?.file_search?.vector_store_ids?.[0];
          
          if (vectorStoreId) {
            console.log(`📚 Adding to vector store: ${vectorStoreId}`);
            await openai.beta.vectorStores.files.create(vectorStoreId, {
              file_id: uploadedFile.id
            });
            console.log("✅ File added to vector store");
          } else {
            console.log("⚠️ No vector store found on assistant");
          }
        } catch (vectorError) {
          console.error("⚠️ Failed to add to vector store:", vectorError);
          // Continue anyway, file is still uploaded
        }
      }
      
      const response = {
        fileId: uploadedFile.id,
        fileName: uploadedFile.filename || fileName,
        fileSize: uploadedFile.bytes || fileSize,
        status: "uploaded"
      };
      
      console.log("🎉 Upload complete:", response);
      
      return {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(response)
      };
      
    } catch (error) {
      console.error("💥 Upload error:", error);
      return {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          error: "Upload failed", 
          message: error.message 
        })
      };
    }
  },
});

console.log("✅ Assistant function with file support setup complete!");
console.log("✅ Upload endpoint configured!");
