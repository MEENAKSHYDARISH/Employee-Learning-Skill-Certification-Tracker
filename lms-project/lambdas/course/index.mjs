import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  GetCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { randomUUID } from "crypto"; // ✅ Added

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const sesClient = new SESClient({});
const SES_SENDER = process.env.SES_SENDER;

export const handler = async (event) => {
  const { httpMethod, resource, pathParameters } = event;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // ROUTE 1: POST /courses (Create Course)
    if (httpMethod === "POST" && resource === "/courses") {
      const {
        title,
        description,
        video_url,
        assigned_roles,
        passingScore,
        questions,
      } = body;
      const course_id = randomUUID(); // ✅ Generate it here
      const normalizedPassingScore =
        typeof passingScore === "number"
          ? passingScore
          : passingScore
            ? Number(passingScore)
            : undefined;

      await docClient.send(
        new PutCommand({
          TableName: "courses",
          Item: {
            course_id, // ✅ Always present now
            title,
            description,
            video_url,
            passingScore: Number.isFinite(normalizedPassingScore)
              ? normalizedPassingScore
              : 70,
            assigned_roles: Array.isArray(assigned_roles)
              ? assigned_roles[0]
              : assigned_roles,
            created_at: new Date().toISOString(),
          },
        }),
      );

      // Persist quiz questions into quiz_answers table for QuizFunction.
      if (Array.isArray(questions) && questions.length > 0) {
        const writeReqs = questions.map((q) => {
          const question_id = randomUUID();
          const options = Array.isArray(q?.options) ? q.options : [];
          return {
            PutRequest: {
              Item: {
                course_id,
                question_id,
                text: q?.text || "",
                options,
                correct_answer: q?.correct_answer || q?.correctAnswer || "",
              },
            },
          };
        });

        for (let i = 0; i < writeReqs.length; i += 25) {
          const chunk = writeReqs.slice(i, i + 25);
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: { quiz_answers: chunk },
            }),
          );
        }
      }

      return response(201, { message: "Course created successfully" });
    }

    // ROUTE 2: GET /courses (List Courses)
    if (httpMethod === "GET" && resource === "/courses") {
      const data = await docClient.send(
        new ScanCommand({ TableName: "courses" }),
      );
      return response(200, data.Items);
    }

    // ROUTE 3: POST /courses/{id}/assign (Assign to Employees)
    if (httpMethod === "POST" && resource === "/courses/{id}/assign") {
      const courseId = pathParameters.id;
      const { target, due_date } = body || {};

      if (!courseId) {
        return response(400, { error: "Missing course id" });
      }

      // 1. Get Course details
      const courseData = await docClient.send(
        new GetCommand({
          TableName: "courses",
          Key: { course_id: courseId },
        }),
      );
      const course = courseData.Item;
      if (!course) {
        return response(404, { error: "Course not found" });
      }

      // 2. Find matching users (Scan users table by role)
      const usersData = await docClient.send(
        new ScanCommand({ TableName: "users" }),
      );
      const allUsers = usersData.Items || [];
      const employees = allUsers.filter((u) => u?.role === "employee");

      const getEmployeeId = (user) => user?.employee_id || user?.id || user?.userId;
      let targetUsers = [];
      if (typeof target === "string" && target.startsWith("user:")) {
        const employeeId = target.slice("user:".length);
        targetUsers = employees.filter(
          (u) => getEmployeeId(u) === employeeId,
        );
      } else if (typeof target === "string" && target.startsWith("role:")) {
        const roleName = target.slice("role:".length);
        if (roleName === "All") {
          targetUsers = employees;
        } else {
          // Match against department, the user's role string, or display label.
          targetUsers = employees.filter(
            (u) =>
              u?.department === roleName ||
              u?.role === roleName ||
              u?.asDept === roleName ||
              getEmployeeId(u) === roleName,
          );
        }
      } else if (course.assigned_roles) {
        // Backward-compatible fallback: assign based on the course's assigned role
        targetUsers = employees.filter(
          (u) => course.assigned_roles === u.role,
        );
      } else {
        return response(400, { error: "Missing assignment target" });
      }

      const completionItems = targetUsers
        .map((user) => {
          const employeeId = getEmployeeId(user);
          if (!employeeId) return null;
          return {
            PutRequest: {
              Item: {
                employee_id: employeeId,
                course_id: courseId,
                status: "not_started",
                attempt_count: 0,
                due_date: due_date || "None",
              },
            },
          };
        })
        .filter(Boolean);

      if (completionItems.length === 0) {
        return response(400, {
          error: "No valid employee targets found for this assignment",
          assigned: targetUsers.length,
        });
      }

      if (completionItems.length === 0) {
        return response(200, { message: "Assigned to 0 employees" });
      }

      // Chunk batch writes (DynamoDB limit is 25 items per batch)
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: { completions: completionItems },
        }),
      );

      // 4. Send Emails via SES
      const sender = SES_SENDER || "no-reply@example.com";
      const emailRequests = targetUsers
        .filter((user) => typeof user?.email === "string" && user.email.trim())
        .map((user) =>
          sesClient.send(
            new SendEmailCommand({
              Destination: { ToAddresses: [user.email.trim()] },
              Message: {
                Body: {
                  Text: {
                    Data: `Hi ${user.name || "there"}, you have been assigned: ${course.title}. View here: ${course.video_url}`,
                  },
                },
                Subject: { Data: "New Course Assignment" },
              },
              Source: sender,
            }),
          ),
        );

      const emailResults = await Promise.allSettled(emailRequests);
      const emailSent = emailResults.filter((r) => r.status === "fulfilled").length;
      const emailFailed = emailResults.length - emailSent;
      return response(200, {
        message: `Assigned to ${targetUsers.length} employees. Emails sent: ${emailSent}, failed: ${emailFailed}`,
      });
    }
  } catch (error) {
    console.error(error);
    return response(500, { error: error.message });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  },
  body: JSON.stringify(body),
});