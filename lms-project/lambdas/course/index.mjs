import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  GetCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const sesClient = new SESClient({});

export const handler = async (event) => {
  const { httpMethod, resource, pathParameters } = event;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // ROUTE 1: POST /courses (Create Course)
    if (httpMethod === "POST" && resource === "/courses") {
      const { course_id, title, description, video_url, assigned_roles } = body;

      await docClient.send(
        new PutCommand({
          TableName: "courses",
          Item: {
            course_id,
            title,
            description,
            video_url,
            // CHANGE THIS: Join the array into a single string or pick the first one
            // For your GSI to work, it needs a single String (S)
            assigned_roles: Array.isArray(assigned_roles)
              ? assigned_roles[0]
              : assigned_roles,
            created_at: new Date().toISOString(),
          },
        }),
      );
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

      // 1. Get Course details
      const courseData = await docClient.send(
        new GetCommand({
          TableName: "courses",
          Key: { course_id: courseId },
        }),
      );
      const course = courseData.Item;

      // 2. Find matching users (Scan users table by role)
      const usersData = await docClient.send(
        new ScanCommand({ TableName: "users" }),
      );
      const targetUsers = usersData.Items.filter(
        (user) => course.assigned_roles === user.role,
      );
      // 3. Batch Write to completions table & Send SES Emails
      const completionItems = targetUsers.map((user) => ({
        PutRequest: {
          Item: {
            employee_id: user.employee_id,
            course_id: courseId,
            status: "not_started",
            attempt_count: 0,
            due_date: body.due_date || "None",
          },
        },
      }));

      // Chunk batch writes (DynamoDB limit is 25 items per batch)
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: { completions: completionItems },
        }),
      );

      // 4. Send Emails via SES
      const emailPromises = targetUsers.map((user) => {
        return sesClient.send(
          new SendEmailCommand({
            Destination: { ToAddresses: [user.email] },
            Message: {
              Body: {
                Text: {
                  Data: `Hi ${user.name}, you have been assigned: ${course.title}. View here: ${course.video_url}`,
                },
              },
              Subject: { Data: "New Course Assignment" },
            },
            Source: "saeetarde@gmail.com", // Must be verified in SES
          }),
        );
      });

      await Promise.all(emailPromises);
      return response(200, {
        message: `Assigned to ${targetUsers.length} employees`,
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
  },
  body: JSON.stringify(body),
});
