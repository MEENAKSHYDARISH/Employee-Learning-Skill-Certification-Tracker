import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  GetCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { randomUUID, createHash } from "crypto"; // ✅ createHash added

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
      const course_id = randomUUID();
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
            course_id,
            title,
            description,
            video_url,
            passingScore: Number.isFinite(normalizedPassingScore)
              ? normalizedPassingScore
              : 70,
            passing_score: Number.isFinite(normalizedPassingScore)
              ? normalizedPassingScore
              : 70,
            assigned_roles: Array.isArray(assigned_roles)
              ? assigned_roles[0]
              : assigned_roles,
            created_at: new Date().toISOString(),
          },
        }),
      );

      // ✅ Save questions WITH correct_answer_hash
      if (Array.isArray(questions) && questions.length > 0) {
        const writeReqs = questions.map((q) => {
          const question_id = randomUUID();
          const options = Array.isArray(q?.options) ? q.options : [];
          const correct_answer = q?.correct_answer || q?.correctAnswer || "";

          // ✅ Hash the correct answer for secure grading
          const correct_answer_hash = createHash("sha256")
            .update(correct_answer)
            .digest("hex");

          console.log(`Saving question: ${q?.text} | correct: ${correct_answer} | hash: ${correct_answer_hash}`);

          return {
            PutRequest: {
              Item: {
                course_id,
                question_id,
                text: q?.text || "",
                options,
                correct_answer,
                correct_answer_hash, // ✅ this is what QuizSubmit uses to grade
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

      const usersData = await docClient.send(
        new ScanCommand({ TableName: "users" }),
      );
      const allUsers = usersData.Items || [];

      const normalize = (value) =>
        typeof value === "string" ? value.trim().toLowerCase() : "";
      const getEmployeeId = (user) =>
        user?.employee_id || user?.id || user?.userId;
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
              normalize(u?.asDept) === normalizedTarget,
          );
        }
      } else if (course.assigned_roles) {
        const normalizedAssignedRole = normalize(course.assigned_roles);
        targetUsers = employees.filter(
          (u) =>
            normalize(u?.role) === normalizedAssignedRole ||
            normalize(u?.department) === normalizedAssignedRole,
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

      for (let i = 0; i < completionItems.length; i += 25) {
        const chunk = completionItems.slice(i, i + 25);
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: { completions: chunk },
          }),
        );
      }

      if (!SES_SENDER) {
        console.warn("SES_SENDER env variable is not configured.");
      } else {
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
              Source: SES_SENDER,
            }),
          }));

        const emailResults = await Promise.allSettled(
          emailRequests.map(({ payload }) => sesClient.send(payload)),
        );

        emailResults.forEach((result, index) => {
          if (result.status === "rejected") {
            console.error(
              "SES send failed for",
              emailRequests[index]?.user?.email,
              result.reason,
            );
          }
        });

        const emailSent = emailResults.filter(
          (r) => r.status === "fulfilled",
        ).length;
        const emailFailed = emailResults.length - emailSent;

        return response(200, {
          message: `Assigned to ${targetUsers.length} employees. Emails sent: ${emailSent}, failed: ${emailFailed}`,
        });
      }

      return response(200, {
        message: `Assigned to ${targetUsers.length} employees.`,
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
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  },
  body: JSON.stringify(body),
});