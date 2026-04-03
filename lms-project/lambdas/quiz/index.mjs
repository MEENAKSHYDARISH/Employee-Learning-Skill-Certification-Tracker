import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const lambdaClient = new LambdaClient({});

export const handler = async (event) => {
  const { httpMethod, pathParameters } = event;
  const courseId = pathParameters?.id;

  let body = {};
  if (event.body) {
    try {
      body =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (err) {
      return response(400, { error: "Invalid JSON body" });
    }
  }

  try {
    if (httpMethod === "OPTIONS") return response(204, {});

    // ROUTE 1: GET Quiz Questions (Hide correct answers)
    if (httpMethod === "GET") {
      const data = await docClient.send(
        new QueryCommand({
          TableName: "quiz_answers",
          KeyConditionExpression: "course_id = :cid",
          ExpressionAttributeValues: { ":cid": courseId },
        }),
      );
      const safeQuestions = data.Items.map(
        ({ correct_answer, correct_answer_hash, ...rest }) => rest,
      );
      return response(200, safeQuestions);
    }

    // ROUTE 2: POST Submit Quiz
    if (httpMethod === "POST") {
      const { employee_id, answers } = body;

      if (!employee_id || !answers) {
        return response(400, { error: "Missing employee_id or answers" });
      }

      // 1. Get Course Info (To get dynamic passingScore)
      const courseData = await docClient.send(
        new GetCommand({
          TableName: "courses",
          Key: { course_id: courseId },
        }),
      );
      const passingThreshold = courseData.Item?.passingScore || 70; // Default to 70 if not found

      // 2. Check Attempts from completions table
      const completion = await docClient.send(
        new GetCommand({
          TableName: "completions",
          Key: { employee_id, course_id: courseId },
        }),
      );

      if (completion.Item?.attempt_count >= 3) {
        return response(403, { error: "Maximum attempts reached (3/3)" });
      }

      // 3. Fetch Correct Answers
      const quizData = await docClient.send(
        new QueryCommand({
          TableName: "quiz_answers",
          KeyConditionExpression: "course_id = :cid",
          ExpressionAttributeValues: { ":cid": courseId },
        }),
      );

      // 4. Grading Logic (Compare submitted to DB)
      let correctCount = 0;
      const totalQuestions = quizData.Items.length;

      quizData.Items.forEach((q) => {
        const submitted = answers.find((a) => a.question_id === q.question_id);
        if (submitted) {
          // Normalize both strings: remove spaces and lowercase
          const clean = (str) =>
            str.toString().replace(/\s+/g, "").toLowerCase();
          if (clean(submitted.answer) === clean(q.correct_answer)) {
            correctCount++;
          }
        }
      });

      const finalScore =
        totalQuestions > 0 ? (correctCount / totalQuestions) * 100 : 0;
      const status = finalScore >= passingThreshold ? "passed" : "failed";

      // 5. Update Completions Table
      const updateRes = await docClient.send(
        new UpdateCommand({
          TableName: "completions",
          Key: { employee_id, course_id: courseId },
          UpdateExpression:
            "SET score = :s, #stat = :t, attempt_count = if_not_exists(attempt_count, :zero) + :i",
          ExpressionAttributeValues: {
            ":s": Math.round(finalScore),
            ":t": status,
            ":i": 1,
            ":zero": 0,
          },
          ExpressionAttributeNames: { "#stat": "status" },
          ReturnValues: "UPDATED_NEW",
        }),
      );

      // 6. Trigger Certificate if passed
      if (status === "passed") {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: process.env.CERTIFICATE_FUNCTION_NAME,
            InvocationType: "Event",
            Payload: JSON.stringify({ employee_id, course_id: courseId }),
          }),
        );
      }

      return response(200, {
        score: Math.round(finalScore),
        status,
        passingScore: passingThreshold,
        attempts: updateRes?.Attributes?.attempt_count,
        message:
          status === "passed"
            ? "Passed! Certificate is being generated."
            : "Did not pass. Try again!",
      });
    }
  } catch (err) {
    console.error(err);
    return response(500, { error: err.message });
  }
};

const response = (s, b) => ({
  statusCode: s,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  },
  body: JSON.stringify(b),
});
