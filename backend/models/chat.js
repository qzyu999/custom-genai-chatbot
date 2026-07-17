import mongoose from "mongoose";

const chatSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    history: [
      {
        role: {
          type: String,
          enum: ["user", "model", "system", "assistant"],
          required: true,
        },
        parts: [
          {
            text: {
              type: String,
              required: true,
            },
          },
        ],
        img: {
          type: String,
          required: false,
        }
      }
    ],
    model: {
      type: String,
      required: true,
    },
    isCustomChatbot: {
      type: Boolean,
      required: true,
      default: false,
    },
    investigations: [
      {
        task: { type: String, required: true },
        status: { type: String, enum: ['running', 'complete', 'failed'], default: 'running' },
        steps: [
          {
            type: { type: String },
            step: Number,
            total: Number,
            detail: String,
            artifact: {
              type: { type: String },
              title: String,
              content: String,
            },
          }
        ],
        result: {
          summary: String,
          artifacts: [
            {
              type: { type: String },
              title: String,
              content: String,
            }
          ],
          duration: Number,
        },
        createdAt: { type: Date, default: Date.now },
      }
    ],
  },
  { timestamps: true }
);

export default mongoose.models.Chat || mongoose.model("Chat", chatSchema);