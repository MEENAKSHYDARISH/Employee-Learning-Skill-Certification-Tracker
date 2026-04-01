import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

export const handler = async () => {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  try {
    // 1. Scan for overdue assignments
    const data = await ddb.send(
      new ScanCommand({
        TableName: "completions",
        FilterExpression: "due_date < :today AND #stat <> :passed",
        ExpressionAttributeValues: {
          ":today": today,
          ":passed": "passed",
        },
        ExpressionAttributeNames: { "#stat": "status" },
      }),
    );

    if (data.Items.length === 0) return { message: "No overdue items today." };

    // 2. Format the Alert Message
    const report = data.Items.map(
      (item) =>
        `- Employee: ${item.employee_id} | Course: ${item.course_id} | Due: ${item.due_date}`,
    ).join("\n");

    const message = `LMS Alert: The following assignments are OVERDUE as of ${today}:\n\n${report}`;

    // 3. Send to SNS
    await sns.send(
      new PublishCommand({
        TopicArn: process.env.SNS_TOPIC_ARN,
        Subject: "🚨 LMS Overdue Assignments Report",
        Message: message,
      }),
    );

    return { status: "Notifications Sent", count: data.Items.length };
  } catch (err) {
    console.error(err);
    throw err;
  }
};
