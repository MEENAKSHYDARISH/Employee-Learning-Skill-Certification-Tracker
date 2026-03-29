import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  const { httpMethod, resource, pathParameters } = event;
  const courseId = pathParameters.id;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // ROUTE 1: GET /courses/{id}/quiz (Fetch Questions)
    if (httpMethod === "GET") {
      const data = await docClient.send(
        new QueryCommand({
          TableName: "quiz_answers",
          KeyConditionExpression: "course_id = :cid",
          ExpressionAttributeValues: { ":cid": courseId },
        }),
      );
      // SECURITY: Strip correct_answer before sending to frontend
      const safeQuestions = data.Items.map(
        ({ correct_answer, ...rest }) => rest,
      );
      return response(200, safeQuestions);
    }

    // ROUTE 2: POST /courses/{id}/quiz/submit (Grade Quiz)
    if (httpMethod === "POST") {
      const { employee_id, answers } = body; // answers: [{question_id: "Q1", answer: "No Server Management"}]

      // 1. Get current completion status
      const completion = await docClient.send(
        new GetCommand({
          TableName: "completions",
          Key: { employee_id, course_id: courseId },
        }),
      );

      if (completion.Item?.attempt_count >= 3) {
        return response(403, { error: "Maximum attempts reached" });
      }

      // 2. Fetch correct hashes
      const data = await docClient.send(
        new QueryCommand({
          TableName: "quiz_answers",
          KeyConditionExpression: "course_id = :cid",
          ExpressionAttributeValues: { ":cid": courseId },
        }),
      );

      // 3. Grade logic
      let score = 0;
      data.Items.forEach((q) => {
        const submitted = answers.find((a) => a.question_id === q.question_id);
        if (submitted) {
          const hashedAnswer = crypto
            .createHash("sha256")
            .update(submitted.answer.trim())
            .digest("hex");
          if (hashedAnswer === q.correct_answer) score++;
        }
      });

      const finalScore = (score / data.Items.length) * 100;
      const status = finalScore >= 70 ? "passed" : "failed";

      // 4. Update Completions table
      await docClient.send(
        new UpdateCommand({
          TableName: "completions",
          Key: { employee_id, course_id: courseId },
          UpdateExpression:
            "SET score = :s, #stat = :t, attempt_count = attempt_count + :i",
          ExpressionAttributeValues: {
            ":s": finalScore,
            ":t": status,
            ":i": 1,
          },
          ExpressionAttributeNames: { "#stat": "status" },
        }),
      );

      return response(200, { score: finalScore, status });
    }
  } catch (err) {
    return response(500, { error: err.message });
  }
};

const response = (s, b) => ({
  statusCode: s,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(b),
});
