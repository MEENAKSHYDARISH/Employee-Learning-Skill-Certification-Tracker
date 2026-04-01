import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event) => {
  const certId = event.pathParameters?.id;

  if (!certId) {
    return response(400, { error: "Certificate ID is required" });
  }

  try {
    // 1. Get the certificate record
    const certData = await ddb.send(
      new GetCommand({
        TableName: "certificates",
        Key: { cert_id: certId },
      }),
    );

    if (!certData.Item) {
      return response(404, {
        valid: false,
        message: "Certificate not found or invalid",
      });
    }

    const { employee_id, course_id, issued_at } = certData.Item;

    // 2. Fetch User and Course details to show the "Proof"
    const [userReq, courseReq] = await Promise.all([
      ddb.send(new GetCommand({ TableName: "users", Key: { employee_id } })),
      ddb.send(new GetCommand({ TableName: "courses", Key: { course_id } })),
    ]);

    return response(200, {
      valid: true,
      certificate_details: {
        cert_id: certId,
        issued_to: userReq.Item?.name || "Unknown Employee",
        course_name: courseReq.Item?.title || "Unknown Course",
        date_of_issue: issued_at,
      },
    });
  } catch (err) {
    console.error(err);
    return response(500, { error: "Internal Server Error" });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*", // Allows anyone to verify
  },
  body: JSON.stringify(body),
});
