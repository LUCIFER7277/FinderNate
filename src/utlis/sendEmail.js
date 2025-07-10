import nodemailer from 'nodemailer';

export const sendEmail = async ({ to, subject, html }) => {
    try {
        console.log("📨 Sending email to:", to);

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const info = await transporter.sendMail({
            from: `"FinderNate" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html,
        });

        console.log("✅ Email sent:", info.messageId);
    } catch (error) {
        console.error("❌ Email send failed:", error);
    }
};
  