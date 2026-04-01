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
const sesClient = new SESClient({ region: process.env.AWS_REGION || "ap-south-1" });
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

      const normalize = (value) =>
        typeof value === "string" ? value.trim().toLowerCase() : "";
      const getEmployeeId = (user) => user?.employee_id || user?.id || user?.userId;
      const getEmailAddress = (user) => {
        const emailCandidate =
          user?.email ||
          user?.Email ||
          user?.emailAddress ||
          user?.username ||
          user?.userName;
        return typeof emailCandidate === "string" && emailCandidate.trim()
          ? emailCandidate.trim()
          : null;
      };

      const employees = allUsers.filter(
        (u) => normalize(u?.role) === "employee",
      );

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
          const normalizedTarget = normalize(roleName);
          targetUsers = employees.filter(
            (u) =>
              normalize(u?.department) === normalizedTarget ||
              normalize(u?.role) === normalizedTarget ||
              normalize(u?.asDept) === normalizedTarget ||
              normalize(getEmployeeId(u)) === normalizedTarget,
          );
        }
      } else if (course.assigned_roles) {
        // Backward-compatible fallback: assign based on the course's assigned role
        const normalizedAssignedRole = normalize(course.assigned_roles);
        targetUsers = employees.filter(
          (u) => normalize(u?.role) === normalizedAssignedRole || normalize(u?.department) === normalizedAssignedRole,
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

      // Chunk batch writes (DynamoDB limit is 25 items per batch)
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: { completions: completionItems },
        }),
      );

      // 4. Send Emails via SES
      if (!SES_SENDER) {
        console.error("SES_SENDER env variable is not configured.");
        return response(500, { error: "SES sender address is not configured" });
      }

      const sender = SES_SENDER;
      const emailRequests = targetUsers
        .map((user) => ({ user, email: getEmailAddress(user) }))
        .filter(({ email }) => email)
        .map(({ user, email }) => ({
          user,
          payload: new SendEmailCommand({
            Destination: { ToAddresses: [email] },
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
        }));

      if (emailRequests.length === 0) {
        return response(200, {
          message: `Assigned to ${targetUsers.length} employees. No valid recipient emails found for sending notifications.`,
          assigned: targetUsers.length,
          emailSent: 0,
          emailFailed: 0,
          emailFailures: [],
        });
      }

      const emailResults = await Promise.allSettled(
        emailRequests.map(({ payload }) => sesClient.send(payload)),
      );

      let emailSent = 0;
      const emailFailures = [];
      emailResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          emailSent++;
        } else {
          const failedUser = emailRequests[index]?.user;
          emailFailures.push({
            user: failedUser?.email || "unknown",
            error: result.reason?.message || String(result.reason),
          });
          console.error(
            "SES send failed for",
            failedUser?.email,
            result.reason,
          );
        }
      });

      const emailFailed = emailRequests.length - emailSent;
      const responsePayload = {
        message: `Assigned to ${targetUsers.length} employees. Emails sent: ${emailSent}, failed: ${emailFailed}`,
        emailFailures,
      };
      return response(200, responsePayload);
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
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  },
  body: JSON.stringify(body),
});