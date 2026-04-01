import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import PDFDocument from "pdfkit";
import crypto from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ses = new SESClient({});

export const handler = async (event) => {
  // Add a console log to see exactly what is arriving
  console.log("Event received:", JSON.stringify(event));

  // Destructure with fallbacks to avoid the "not defined" error
  const employee_id = event.employee_id;
  const course_id = event.course_id;

  if (!employee_id || !course_id) {
    console.error("Missing IDs in event!");
    return { status: "failed", error: "Missing employee_id or course_id" };
  }

  try {
    // 1. Fetch User & Course details for the PDF
    const [userReq, courseReq] = await Promise.all([
      ddb.send(new GetCommand({ TableName: "users", Key: { employee_id } })),
      ddb.send(new GetCommand({ TableName: "courses", Key: { course_id } })),
    ]);

    const userName = userReq.Item?.name || "Employee";
    const courseTitle = courseReq.Item?.title || "Course";
    const certId = crypto.randomUUID();
    const date = new Date().toLocaleDateString();

    // 2. Generate PDF in Memory
    const pdfBuffer = await new Promise((resolve) => {
      const doc = new PDFDocument({ size: "A4", layout: "landscape" });
      let buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      // Design
      doc
        .rect(20, 20, doc.page.width - 40, doc.page.height - 40)
        .stroke("#1a3a5c");
      doc.fontSize(40).text("CERTIFICATE OF COMPLETION", { align: "center" });
      doc.moveDown();
      doc.fontSize(20).text("This is to certify that", { align: "center" });
      doc.fontSize(30).fillColor("#1a3a5c").text(userName, { align: "center" });
      doc
        .fillColor("black")
        .fontSize(20)
        .text(`has successfully passed ${courseTitle}`, { align: "center" });
      doc.moveDown();
      doc
        .fontSize(12)
        .text(`Date: ${date} | Certificate ID: ${certId}`, { align: "center" });
      doc.end();
    });

    // 3. Upload to S3
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.CERT_BUCKET,
        Key: `certificates/${certId}.pdf`,
        Body: pdfBuffer,
        ContentType: "application/pdf",
      }),
    );

    // 4. Create Pre-signed URL (Valid for 7 days)
    const command = new GetObjectCommand({
      Bucket: process.env.CERT_BUCKET,
      Key: `certificates/${certId}.pdf`,
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 604800 });

    // 5. Save to Certificates Table
    await ddb.send(
      new PutCommand({
        TableName: "certificates",
        Item: {
          cert_id: certId,
          employee_id,
          course_id,
          issued_at: date,
          s3_key: `certificates/${certId}.pdf`,
        },
      }),
    );

    // 6. Send Email via SES
    await ses.send(
      new SendEmailCommand({
        Source: process.env.SES_SENDER,
        Destination: { ToAddresses: [userReq.Item.email] },
        Message: {
          Subject: {
            Data: `Congratulations! Your Certificate for ${courseTitle}`,
          },
          Body: {
            Html: {
              Data: `<h1>Great job!</h1><p>Download your certificate here: <a href="${downloadUrl}">Link</a></p>`,
            },
          },
        },
      }),
    );

    return { status: "Certificate Sent", certId };
  } catch (err) {
    console.error(err);
    throw err;
  }
};
