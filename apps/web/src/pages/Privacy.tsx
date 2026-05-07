import LegalPageLayout from "@/components/LegalPageLayout";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";

const Privacy = () => (
  <LegalPageLayout>
    <SEOHead
      title="Privacy Policy"
      description="Learn how grace collects, uses, and protects your personal information. Your phone number and data are encrypted and never sold."
      canonical="/privacy"
      jsonLd={breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Privacy Policy", path: "/privacy" },
      ])}
    />
    <h1>PRIVACY POLICY</h1>
    <p className="text-muted-foreground text-sm !mt-1 !mb-6">Last Updated: April 12, 2026 · Effective Date: April 12, 2026</p>

    <p>This Privacy Policy describes how STEIMBROS, LLC ("Company," "we," "us," or "our") collects, uses, discloses, and protects your personal information when you use the grace text messaging service and associated website (collectively, the "Service"). By using the Service, you agree to the collection and use of your information as described in this Privacy Policy.</p>

    <h2>1. WHO WE ARE</h2>
    <p>STEIMBROS, LLC is a Delaware limited liability company with its principal place of business at 1207 Delaware Ave, Suite 1516, Wilmington, DE 19806. We operate the grace wellness companion service, which delivers SMS-based health habit reminders and motivational support to users.</p>
    <p>For privacy-related inquiries, contact us at: privacy@graceglp.com</p>

    <h2>2. INFORMATION WE COLLECT</h2>
    <p><strong>Information you provide directly:</strong></p>
    <ul>
      <li>Full name and first name</li>
      <li>Mobile phone number</li>
      <li>GLP-1 medication type</li>
      <li>Injection schedule and day of week</li>
      <li>Personal health goals</li>
      <li>Wake time and sleep time</li>
      <li>Dietary preferences and food restrictions</li>
      <li>Body weight (current and goal), if voluntarily provided</li>
      <li>Mood scores and symptom reports submitted via SMS reply</li>
      <li>Food and hydration logs submitted via SMS reply</li>
      <li>Any other information you voluntarily share in SMS messages to us</li>
    </ul>
    <p><strong>Information collected automatically:</strong></p>
    <ul>
      <li>SMS message logs (inbound and outbound), including timestamps and content</li>
      <li>Device timezone (collected via browser during onboarding)</li>
      <li>Engagement data (whether messages were received, reply patterns, response timing)</li>
      <li>IP address and browser type during onboarding</li>
    </ul>
    <p><strong>Information we do not collect:</strong></p>
    <ul>
      <li>We do not collect Social Security numbers, financial account information, or government-issued ID numbers through the Service.</li>
      <li>We do not access your device's contacts, camera, microphone, or location.</li>
    </ul>

    <h2>3. HOW WE USE YOUR INFORMATION</h2>
    <p>We use the information we collect to:</p>
    <ul>
      <li>Deliver the grace SMS service, including scheduled check-in messages, reminders, and personalized responses</li>
      <li>Personalize message timing, content, and frequency based on your preferences and engagement patterns</li>
      <li>Track your wellness journey data (weight logs, mood scores, injection history) as directed by you</li>
      <li>Process subscription payments through our payment processor (Stripe)</li>
      <li>Respond to your SMS replies and inbound messages</li>
      <li>Send service-related communications, including updates to these policies</li>
      <li>Comply with legal obligations</li>
      <li>Protect the safety of users and third parties</li>
      <li>Improve and develop the Service</li>
    </ul>
    <p>We do not use your personal information to make automated decisions that have legal or similarly significant effects on you without human review.</p>

    <h2>4. HOW WE SHARE YOUR INFORMATION</h2>
    <p>We do not sell your personal information. We do not share your personal information with third parties for their own marketing purposes.</p>
    <p>We share your information only in the following circumstances:</p>
    <p><strong>Service providers:</strong> We share information with third-party vendors who help us operate the Service, including:</p>
    <ul>
      <li>Twilio Inc. (SMS delivery and management)</li>
      <li>Supabase Inc. (database and infrastructure)</li>
      <li>Stripe Inc. (payment processing)</li>
    </ul>
    <p>These providers are contractually obligated to use your information only to provide services to us and to protect your information consistent with this Privacy Policy.</p>
    <p><strong>Legal requirements:</strong> We may disclose your information if required by law, subpoena, court order, or government request, or if we believe disclosure is necessary to protect the rights, property, or safety of STEIMBROS, LLC, our users, or the public.</p>
    <p><strong>Business transfers:</strong> In the event of a merger, acquisition, or sale of all or substantially all of our assets, your information may be transferred as part of that transaction. We will notify you via SMS prior to your information being transferred and becoming subject to a different privacy policy.</p>
    <p><strong>With your consent:</strong> We may share your information with third parties when you have given us explicit consent to do so.</p>
    <p>All the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties or affiliates for marketing or promotional purposes. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</p>

    <h2>5. SMS MESSAGING AND TCPA COMPLIANCE</h2>
    <p>By providing your mobile phone number and checking the consent box during onboarding, you expressly consent to receive recurring automated text messages from STEIMBROS, LLC at the mobile number provided. Message frequency varies based on your settings, typically 1–3 messages per day. Message and data rates may apply.</p>
    <p>You may opt out at any time by replying STOP to any message from us. After opting out, you will receive one final confirmation message and will receive no further messages. To re-subscribe, text START to the same number.</p>
    <p>For help, reply HELP or contact us at support@graceglp.com.</p>
    <p>We do not use automatic telephone dialing systems or artificial/prerecorded voice messages for voice calls.</p>

    <h2>6. DATA RETENTION</h2>
    <p>We retain your personal information for as long as your account is active or as needed to provide the Service. If you opt out of SMS messages or request deletion of your account, we will delete or anonymize your personal information within 30 days, except where we are required to retain it for legal, regulatory, or legitimate business purposes (such as resolving disputes or complying with applicable law).</p>
    <p>SMS message logs may be retained for up to 12 months for operational and safety purposes, after which they are deleted or anonymized.</p>

    <h2>7. DATA SECURITY</h2>
    <p>We implement industry-standard technical and organizational measures to protect your personal information against unauthorized access, alteration, disclosure, or destruction. These measures include encryption of data in transit and at rest, access controls, and regular security reviews.</p>
    <p>However, no method of transmission over the Internet or method of electronic storage is 100% secure. We cannot guarantee absolute security of your information. By using the Service, you acknowledge and accept this risk.</p>

    <h2>8. CHILDREN'S PRIVACY</h2>
    <p>The Service is not intended for, and we do not knowingly collect personal information from, individuals under the age of 18. If we become aware that we have collected personal information from a minor without parental consent, we will delete that information promptly. If you believe we have inadvertently collected information from a minor, please contact us at privacy@graceglp.com.</p>

    <h2>9. YOUR PRIVACY RIGHTS</h2>
    <p>Depending on your state of residence, you may have the following rights:</p>
    <p><strong>All users:</strong></p>
    <ul>
      <li>Right to know what personal information we collect and how we use it</li>
      <li>Right to opt out of SMS communications at any time by replying STOP</li>
      <li>Right to request deletion of your personal information by contacting privacy@graceglp.com</li>
    </ul>
    <p><strong>California residents (CCPA/CPRA):</strong></p>
    <ul>
      <li>Right to know the categories and specific pieces of personal information collected about you</li>
      <li>Right to delete personal information we hold about you, subject to certain exceptions</li>
      <li>Right to correct inaccurate personal information</li>
      <li>Right to opt out of the sale or sharing of personal information (we do not sell or share personal information)</li>
      <li>Right to non-discrimination for exercising your privacy rights</li>
      <li>To submit a verifiable request, contact us at privacy@graceglp.com</li>
    </ul>
    <p><strong>Other state residents:</strong> Residents of Virginia, Colorado, Connecticut, Texas, and other states with comprehensive privacy laws may have similar rights. Contact us at privacy@graceglp.com to exercise any applicable rights.</p>
    <p>We will respond to verifiable privacy rights requests within 45 days. We may request additional information to verify your identity before processing your request.</p>

    <h2>10. THIRD-PARTY LINKS AND SERVICES</h2>
    <p>The Service may include links to third-party websites or services. We are not responsible for the privacy practices of those third parties. We encourage you to review the privacy policies of any third-party services you access through our Service.</p>

    <h2>11. CHANGES TO THIS PRIVACY POLICY</h2>
    <p>We may update this Privacy Policy from time to time. When we make material changes, we will notify you by SMS at least 10 days before the changes take effect and will update the "Last Updated" date at the top of this page. Your continued use of the Service after changes become effective constitutes acceptance of the revised Privacy Policy.</p>

    <h2>12. CONTACT US</h2>
    <p>STEIMBROS, LLC<br />1207 Delaware Ave, Suite 1516<br />Wilmington, DE 19806<br />Email: privacy@graceglp.com</p>
  </LegalPageLayout>
);

export default Privacy;
