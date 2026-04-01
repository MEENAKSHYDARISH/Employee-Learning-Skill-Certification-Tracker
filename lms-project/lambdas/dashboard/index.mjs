import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event) => {
  const employeeId = event.pathParameters?.id;

  try {
    // 1. Fetch User details to find their Role
    const userRes = await ddb.send(
      new GetCommand({
        TableName: "users",
        Key: { employee_id: employeeId },
      }),
    );

    if (!userRes.Item) {
      return response(404, { error: "User not found" });
    }

    const userRole = userRes.Item.role;

    // 2. Fetch all Courses and filter by Role
    // (Note: In a huge company, you'd use a Query on a GSI, but Scan is fine for now)
    const coursesRes = await ddb.send(
      new ScanCommand({ TableName: "courses" }),
    );
    const myCourses = coursesRes.Items.filter(
      (course) =>
        course.assigned_roles && course.assigned_roles.includes(userRole),
    );

    // 3. Fetch all Completions for this specific user
    const completionsRes = await ddb.send(
      new ScanCommand({
        TableName: "completions",
        FilterExpression: "employee_id = :eid",
        ExpressionAttributeValues: { ":eid": employeeId },
      }),
    );

    // 4. Fetch all Certificates for this specific user
    const certsRes = await ddb.send(
      new ScanCommand({
        TableName: "certificates",
        FilterExpression: "employee_id = :eid",
        ExpressionAttributeValues: { ":eid": employeeId },
      }),
    );

    // 5. THE JOIN LOGIC: Merge everything into one object
    const dashboardData = myCourses.map((course) => {
      const completion = completionsRes.Items.find(
        (c) => c.course_id === course.course_id,
      );
      const certificate = certsRes.Items.find(
        (cert) => cert.course_id === course.course_id,
      );

      return {
        course_id: course.course_id,
        title: course.title,
        description: course.description,
        video_url: course.video_url,
        // Status defaults to 'not-started' if no completion record exists
        status: completion?.status || "not started",
        score: completion?.score || 0,
        attempts: completion?.attempt_count || 0,
        due_date: completion?.due_date || "N/A",
        // Provide cert_id if they passed
        cert_id: certificate?.cert_id || null,
        s3_link: certificate
          ? `https://${process.env.CERT_BUCKET}.s3.amazonaws.com/${certificate.s3_key}`
          : null,
      };
    });

    return response(200, {
      employee: {
        name: userRes.Item.name,
        role: userRole,
        department: userRes.Item.department,
      },
      courses: dashboardData,
    });
  } catch (err) {
    console.error(err);
    return response(500, { error: "Failed to load dashboard" });
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
