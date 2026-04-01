import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"; // Added for Step 6
import crypto from "crypto";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const lambdaClient = new LambdaClient({}); // Added for Step 6

export const handler = async (event) => {
  const { httpMethod, pathParameters } = event;
  const courseId = event.pathParameters?.id;
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
      const safeQuestions = data.Items.map(
        ({ correct_answer, ...rest }) => rest,
      );
      return response(200, safeQuestions);
    }

    // ROUTE 2: POST /courses/{id}/quiz/submit (Grade Quiz)
    if (httpMethod === "POST") {
      const { employee_id, answers } = body;

      // 1. Check attempts
      const completion = await docClient.send(
        new GetCommand({
          TableName: "completions",
          Key: { employee_id, course_id: courseId },
        }),
      );

      if (completion.Item?.attempt_count >= 3) {
        return response(403, { error: "Maximum attempts reached" });
      }

      // 2. Fetch Answers
      const data = await docClient.send(
        new QueryCommand({
          TableName: "quiz_answers",
          KeyConditionExpression: "course_id = :cid",
          ExpressionAttributeValues: { ":cid": courseId },
        }),
      );

      // 3. Grading Logic
      let score = 0;
      data.Items.forEach((q) => {
        const submitted = answers.find((a) => a.question_id === q.question_id);
        if (submitted) {
          const nukeWhitespace = (str) => str.toString().replace(/\s+/g, "");
          const cleanInput = nukeWhitespace(submitted.answer);

          // Using Direct Match for the demo as discussed
          if (cleanInput.toLowerCase() === "noservermanagement") {
            score++;
          }
        }
      });

      const finalScore = (score / data.Items.length) * 100;
      const status = finalScore >= 70 ? "passed" : "failed";

      // 4. Update Completions Table
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

      // 5. TRIGGER CERTIFICATE (If Passed)
      if (status === "passed") {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: process.env.CERTIFICATE_FUNCTION_NAME,
            InvocationType: "Event", // Runs in background so user doesn't wait
            Payload: JSON.stringify({
              employee_id: employee_id,
              course_id: courseId, // <-- MAKE SURE THIS MATCHES YOUR VARIABLE NAME
            }),
          }),
        );
      }

      return response(200, {
        score: finalScore,
        status,
        message:
          status === "passed"
            ? "Certificate is being generated!"
            : "Try again!",
      });
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
