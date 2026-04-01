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
import crypto from "crypto";

function createPdfBuffer({ userName, courseTitle, certId, date }) {
  const pageWidth = 842;
  const pageHeight = 595;
  const escapeText = (text) =>
    text
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");

  const lines = [
    { size: 40, y: 520, text: "CERTIFICATE OF COMPLETION" },
    { size: 20, y: 470, text: "This is to certify that" },
    { size: 30, y: 430, text: userName },
    { size: 20, y: 380, text: `has successfully passed ${courseTitle}` },
    { size: 12, y: 340, text: `Date: ${date} | Certificate ID: ${certId}` },
  ];

  const contentLines = lines
    .map(
      (line) =>
        `/F1 ${line.size} Tf\n100 ${line.y} Td\n(${escapeText(
          line.text,
        )}) Tj`,
    )
    .join("\n");

  const content = `q\n1 w\n20 20 ${pageWidth - 40} ${pageHeight - 40} re\nS\nQ\nBT\n${contentLines}\nET\n`;
  const contentBytes = Buffer.from(content, "utf8");

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const objects = [];

  objects.push(
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
  );
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
  );
  objects.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );
  objects.push(
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );
  objects.push(
    `5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n${content}endstream\nendobj\n`,
  );

  const buffers = [Buffer.from(header, "utf8")];
  const offsets = [0];
  let position = Buffer.byteLength(header, "utf8");

  for (const obj of objects) {
    offsets.push(position);
    const buffer = Buffer.from(obj, "utf8");
    buffers.push(buffer);
    position += buffer.length;
  }

  const xrefStart = position;
  let xref = "xref\n0 6\n";
  xref += `0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${offsets[i].toString().padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  buffers.push(Buffer.from(xref + trailer, "utf8"));

  return Buffer.concat(buffers);
}

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
    const pdfBuffer = createPdfBuffer({
      userName,
      courseTitle,
      certId,
      date,
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
