import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ChartData } from "@/types/chart";

// Initialize Google AI client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY!);

export const runtime = "edge";

// Helper to validate base64
const isValidBase64 = (str: string) => {
  try {
    return btoa(atob(str)) === str;
  } catch (err) {
    return false;
  }
};

// Add Type Definitions
interface ChartToolResponse extends ChartData {
  // Any additional properties specific to the tool response
}


const tools = [
  {
    name: "generate_graph_data",
    description:
      "Generate structured JSON data for creating financial charts and graphs.",
      parameters: {
      type: "object",
      properties: {
        chartType: {
          type: "string",
          enum: [
            "bar",
            "multiBar",
            "line",
            "pie",
            "area",
            "stackedArea",
          ],
          description: "The type of chart to generate",
        },
        config: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            trend: {
              type: "object",
              properties: {
                percentage: { type: "number" },
                direction: {
                  type: "string",
                  enum: ["up", "down"],
                },
              },
              required: ["percentage", "direction"],
            },
            footer: { type: "string" },
            totalLabel: { type: "string" },
            xAxisKey: { type: "string" },
          },
          required: ["title", "description"],
        },
        data: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
          },
        },
        chartConfig: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              label: { type: "string" },
              stacked: { type: "boolean" },
            },
            required: ["label"],
          },
        },
      },
      required: ["chartType", "config", "data", "chartConfig"],
    },
  },
];

const SYSTEM_PROMPT = `You are a financial data visualization expert. Your role is to analyze financial data and create clear, meaningful visualizations using generate_graph_data tool:

Here are the chart types available and their ideal use cases:

1. LINE CHARTS ("line")
   - Time series data showing trends
   - Financial metrics over time
   - Market performance tracking

2. BAR CHARTS ("bar")
   - Single metric comparisons
   - Period-over-period analysis
   - Category performance

3. MULTI-BAR CHARTS ("multiBar")
   - Multiple metrics comparison
   - Side-by-side performance analysis
   - Cross-category insights

4. AREA CHARTS ("area")
   - Volume or quantity over time
   - Cumulative trends
   - Market size evolution

5. STACKED AREA CHARTS ("stackedArea")
   - Component breakdowns over time
   - Portfolio composition changes
   - Market share evolution

6. PIE CHARTS ("pie")
   - Distribution analysis
   - Market share breakdown
   - Portfolio allocation

When generating visualizations:
1. Structure data correctly based on the chart type
2. Use descriptive titles and clear descriptions
3. Include trend information when relevant (percentage and direction)
4. Add contextual footer notes
5. Use proper data keys that reflect the actual metrics

Always:
- Generate real, contextually appropriate data
- Use proper financial formatting
- Include relevant trends and insights
- Structure data exactly as needed for the chosen chart type
- Choose the most appropriate visualization for the data

Never:
- Use placeholder or static data
- Include technical implementation details in responses

Focus on clear financial insights and let the visualization enhance understanding.`;

export async function POST(req: NextRequest) {
  try {
    const { messages, fileData, model2 } = await req.json();

    console.log("🔍 Initial Request Data:", {
      hasMessages: !!messages,
      messageCount: messages?.length,
      hasFileData: !!fileData,
      fileType: fileData?.mediaType,
      model:model2,
    });

    // Input validation
    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: "Messages array is required" }),
        { status: 400 },
      );
    }

    // Format messages for Gemini
    let formattedMessages = messages.map((msg: any) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    }));

    // Handle file in the latest message
    if (fileData) {
      const { base64, mediaType, isText } = fileData;

      if (!base64) {
        console.error("❌ No base64 data received");
        return new Response(JSON.stringify({ error: "No file data" }), {
          status: 400,
        });
      }

      try {
        if (isText) {
          // Decode base64 text content
          const textContent = decodeURIComponent(escape(atob(base64)));
          
          // Update the last message with file content
          formattedMessages[formattedMessages.length - 1] = {
            role: "user",
            parts: [{
              text: `File contents of ${fileData.fileName}:\n\n${textContent}\n\n${messages[messages.length - 1].content}`
            }],
          };
        } else if (mediaType.startsWith("image/")) {
          // Handle image files - Gemini requires different image handling
          //const model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
          // Convert base64 to Uint8Array for Gemini
          //const imageData = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          
          formattedMessages[formattedMessages.length - 1] = {
            role: "user",
            parts: [
              {
                inlineData: {
                  data: base64,
                  mimeType: mediaType
                }
              },
              {
                text: messages[messages.length - 1].content
              }
            ],
          };
        }
      } catch (error) {
        console.error("Error processing file content:", error);
        return new Response(
          JSON.stringify({ error: "Failed to process file content" }),
          { status: 400 },
        );
      }
    }

    // Initialize the chat
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-pro",
      tools: { functionDeclarations: tools },
     });
    const chat = model.startChat({
      history: formattedMessages.slice(0, -1),
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    });

    // Add system prompt to the context
    await chat.sendMessage(SYSTEM_PROMPT);

    // Send the last message and get response
    const result = await chat.sendMessage(formattedMessages[formattedMessages.length - 1].parts[0].text);
    const response = await result.response;
    const responseText = response.text();

    // Parse the response to extract tool usage and chart data
    const toolUseMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
    let toolUseContent = null;
    let chartData = null;

    if (toolUseMatch) {
      try {
        toolUseContent = JSON.parse(toolUseMatch[1]);
        chartData = processToolResponse(toolUseContent);
      } catch (e) {
        console.error("Failed to parse tool use content:", e);
      }
    }

    // Process tool response function
    function processToolResponse(toolUseContent: any): ChartToolResponse | null {
      if (!toolUseContent) return null;

      const chartData = toolUseContent as ChartToolResponse;

      if (
        !chartData.chart_type ||
        !chartData.data ||
        !Array.isArray(chartData.data)
      ) {
        throw new Error("Invalid chart data structure");
      }

      // Transform data for pie charts
      if (chartData.chart_type === "pie") {
        chartData.data = chartData.data.map((item) => {
          const valueKey = Object.keys(chartData.chartConfig)[0];
          const segmentKey = chartData.config.xAxisKey || "segment";

          return {
            segment: item[segmentKey] || item.segment || item.category || item.name,
            value: item[valueKey] || item.value,
          };
        });

        chartData.config.xAxisKey = "segment";
      }

      // Create chartConfig with system color variables
      const processedChartConfig = Object.entries(chartData.chartConfig).reduce(
        (acc, [key, config], index) => ({
          ...acc,
          [key]: {
            ...config,
            color: `hsl(var(--chart-${index + 1}))`,
          },
        }),
        {},
      );

      return {
        ...chartData,
        chartConfig: processedChartConfig,
      };
    }

    return new Response(
      JSON.stringify({
        content: responseText,
        hasToolUse: !!toolUseContent,
        toolUse: toolUseContent,
        chartData: chartData,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
      },
    );
  } catch (error) {
    console.error("❌ Finance API Error: ", error);
    console.error("Full error details:", {
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Error handling for different scenarios
    if (error instanceof Error) {
      // Handle specific Google AI API errors
      if (error.message.includes("PERMISSION_DENIED")) {
        return new Response(
          JSON.stringify({
            error: "Authentication Error",
            details: "Invalid API key or authentication failed",
          }),
          { status: 401 },
        );
      }

      return new Response(
        JSON.stringify({
          error: error.message,
          details: "API Error",
        }),
        { status: 500 },
      );
    }

    return new Response(
      JSON.stringify({
        error: "An unknown error occurred",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}