import LegalPageLayout from "@/components/LegalPageLayout";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";

const Terms = () => (
  <LegalPageLayout>
    <SEOHead
      title="Terms of Service"
      description="Terms of Service for grace, the personalized SMS companion for GLP-1 weight loss journeys. Read before signing up."
      canonical="/terms"
      jsonLd={breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Terms of Service", path: "/terms" },
      ])}
    />
    <h1>TERMS OF SERVICE</h1>
    <p className="text-muted-foreground text-sm !mt-1 !mb-6">Last Updated: April 12, 2026 · Effective Date: April 12, 2026</p>

    <p>Please read these Terms of Service ("Terms") carefully before using the grace service. By completing onboarding or using the Service, you agree to be bound by these Terms.</p>

    <h2>1. ACCEPTANCE OF TERMS</h2>
    <p>These Terms constitute a legally binding agreement between you ("User," "you," or "your") and STEIMBROS, LLC, a Delaware limited liability company ("Company," "we," "us," or "our"). If you do not agree to these Terms, do not use the Service.</p>
    <p>We reserve the right to modify these Terms at any time. Material changes will be communicated via SMS at least 10 days in advance. Your continued use of the Service after changes take effect constitutes acceptance.</p>

    <h2>2. DESCRIPTION OF SERVICE</h2>
    <p>grace is a wellness habit companion delivered via SMS text messaging. The Service provides:</p>
    <ul>
      <li>Scheduled wellness check-in messages</li>
      <li>Medication injection reminders (timing only — not dosage or medical guidance)</li>
      <li>Habit tracking and motivational messaging</li>
      <li>General wellness information and healthy living suggestions</li>
    </ul>
    <p>The Service is a habit and motivation tool only. It is explicitly not a medical service, healthcare provider, clinical program, or substitute for professional medical care of any kind.</p>

    <h2>3. ELIGIBILITY</h2>
    <p>You must be at least 18 years of age to use the Service. By using the Service, you represent and warrant that you are at least 18 years old and have the legal capacity to enter into this agreement.</p>
    <p>This Service is currently available to residents of the United States and Israel. Users outside these regions may not receive full SMS functionality.</p>

    <h2>4. ACCOUNT REGISTRATION AND SMS CONSENT</h2>
    <p>To use the Service, you must provide a valid U.S. mobile phone number and consent to receive recurring automated SMS messages. You represent that:</p>
    <ul>
      <li>You are the account holder or authorized user of the mobile number provided</li>
      <li>You have the authority to consent to SMS messages at that number</li>
      <li>All information you provide during onboarding is accurate and complete</li>
    </ul>
    <p>You are responsible for maintaining the accuracy of your account information and for all activity associated with your account.</p>

    <h2>4A. SMS MESSAGING PROGRAM TERMS</h2>
    <p><strong>Program Name:</strong> Grace</p>
    <p><strong>Program Description:</strong> Grace is a wellness habit companion that delivers recurring automated SMS check-ins, GLP-1 injection reminders, hydration and nutrition nudges, and motivational support to help users build and maintain healthy habits.</p>
    <p>Message and data rates may apply.</p>
    <p>Message frequency varies.</p>
    <p>For support, contact <a href="mailto:support@graceglp.com">support@graceglp.com</a>.</p>
    <p><strong>Reply STOP to cancel, HELP for help.</strong></p>
    <p>For details on how we handle your information, see our <a href="/privacy">Privacy Policy</a>.</p>
    <p>Carriers are not liable for delayed or undelivered messages.</p>

    <h2>5. SUBSCRIPTION AND PAYMENT</h2>
    <p><strong>Free Trial:</strong> 3 days unlimited, then subscription required to continue service.</p>
    <p><strong>Paid Subscription:</strong> After the free trial, continued access requires a subscription:</p>
    <ul>
      <li>Grace Base Plan: $12.00 per month</li>
      <li>Grace Pro Plan: $24.00 per month</li>
    </ul>
    <p>Subscriptions are billed monthly to the payment method on file and automatically renew unless cancelled.</p>
    <p><strong>Cancellation:</strong> You may cancel your subscription at any time by contacting support@graceglp.com or by replying STOP to any message, which will also cancel your SMS service. Cancellation takes effect at the end of the current billing period. No refunds are provided for partial months.</p>
    <p><strong>Payment Processing:</strong> Payments are processed by Stripe. We do not store your full credit card information. By providing payment information, you agree to Stripe's terms of service.</p>
    <p><strong>Price Changes:</strong> We reserve the right to change subscription pricing upon 30 days' notice via SMS.</p>

    <h2>6. ACCEPTABLE USE</h2>
    <p>You agree to use the Service only for its intended purpose of personal wellness habit support. You agree not to:</p>
    <ul>
      <li>Provide false information during onboarding or in SMS replies</li>
      <li>Use the Service on behalf of another person without their explicit consent</li>
      <li>Attempt to reverse engineer, copy, or replicate the Service</li>
      <li>Use the Service for any unlawful purpose</li>
      <li>Harass, abuse, or send threatening or offensive content via SMS reply</li>
      <li>Attempt to circumvent any security or access controls</li>
    </ul>
    <p>We reserve the right to terminate your access to the Service immediately and without notice if you violate these Terms.</p>

    <h2>7. INTELLECTUAL PROPERTY</h2>
    <p>All content, messaging, systems, workflows, and materials that make up the grace Service are the exclusive property of STEIMBROS, LLC and are protected by applicable intellectual property laws. You are granted a limited, non-exclusive, non-transferable license to use the Service for personal, non-commercial purposes only.</p>
    <p>You may not reproduce, distribute, create derivative works from, or commercially exploit any part of the Service without our express written permission.</p>

    <h2>8. TERMINATION</h2>
    <p>We may suspend or terminate your access to the Service at any time, with or without cause, with or without notice, effective immediately. Grounds for termination include but are not limited to violation of these Terms, suspected fraudulent or abusive activity, or discontinuation of the Service.</p>
    <p>You may terminate your use of the Service at any time by replying STOP to any message or by contacting support@graceglp.com.</p>
    <p>Upon termination, your right to use the Service immediately ceases. Provisions of these Terms that by their nature should survive termination will survive, including but not limited to Sections 9, 10, 11, 12, and 13.</p>

    <h2>9. DISCLAIMERS — PLEASE READ CAREFULLY</h2>
    <p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED.</p>
    <p>TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, STEIMBROS, LLC EXPRESSLY DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO:</p>
    <ul>
      <li>IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT</li>
      <li>WARRANTIES THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE</li>
      <li>WARRANTIES REGARDING THE ACCURACY, COMPLETENESS, OR TIMELINESS OF ANY CONTENT OR INFORMATION DELIVERED THROUGH THE SERVICE</li>
      <li>WARRANTIES THAT THE SERVICE WILL MEET YOUR SPECIFIC HEALTH, WELLNESS, OR MEDICAL NEEDS</li>
    </ul>
    <p>SMS delivery is dependent on third-party carriers and Twilio. We do not warrant that messages will be delivered at the times scheduled or at all. We are not liable for carrier delays, outages, or filtering.</p>

    <h2>10. LIMITATION OF LIABILITY</h2>
    <p>TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL STEIMBROS, LLC, ITS MEMBERS, MANAGERS, EMPLOYEES, CONTRACTORS, OR AGENTS BE LIABLE FOR ANY:</p>
    <ul>
      <li>INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES</li>
      <li>LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR OTHER INTANGIBLE LOSSES</li>
      <li>DAMAGES ARISING FROM YOUR RELIANCE ON ANY INFORMATION OR CONTENT PROVIDED BY THE SERVICE</li>
      <li>DAMAGES ARISING FROM MISSED MESSAGES, DELAYED MESSAGES, OR FAILURE OF THE SERVICE TO DELIVER MESSAGES</li>
      <li>DAMAGES ARISING FROM YOUR HEALTH DECISIONS, MEDICATION DECISIONS, OR MEDICAL OUTCOMES IN CONNECTION WITH USE OF THE SERVICE</li>
    </ul>
    <p>IN JURISDICTIONS WHERE LIMITATION OF LIABILITY IS NOT PERMITTED, OUR LIABILITY SHALL BE LIMITED TO THE MAXIMUM EXTENT PERMITTED BY LAW.</p>
    <p>IN ANY EVENT, OUR TOTAL CUMULATIVE LIABILITY TO YOU FOR ANY CLAIMS ARISING UNDER THESE TERMS SHALL NOT EXCEED THE AMOUNT YOU PAID TO STEIMBROS, LLC IN THE THREE MONTHS PRECEDING THE CLAIM.</p>

    <h2>11. INDEMNIFICATION</h2>
    <p>You agree to indemnify, defend, and hold harmless STEIMBROS, LLC and its members, managers, employees, contractors, and agents from and against any and all claims, liabilities, damages, losses, costs, and expenses (including reasonable attorneys' fees) arising out of or relating to:</p>
    <ul>
      <li>Your use of the Service</li>
      <li>Your violation of these Terms</li>
      <li>Your violation of any applicable law or regulation</li>
      <li>Your reliance on any information or content provided through the Service for medical, clinical, or health treatment decisions</li>
      <li>Any claim by a third party arising from your use of the Service</li>
    </ul>

    <h2>12. GOVERNING LAW AND DISPUTE RESOLUTION</h2>
    <p>These Terms are governed by and construed in accordance with the laws of the State of Delaware, without regard to its conflict of law provisions.</p>
    <p><strong>Arbitration:</strong> Any dispute, claim, or controversy arising out of or relating to these Terms or the Service shall be resolved by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, rather than in court. You waive your right to a jury trial and to participate in class action litigation.</p>
    <p><strong>Class Action Waiver:</strong> You agree that any arbitration or legal proceeding shall be conducted only on an individual basis and not as a class, consolidated, or representative action.</p>
    <p><strong>Exceptions:</strong> Either party may seek emergency injunctive or other equitable relief in a court of competent jurisdiction in the State of Delaware to prevent irreparable harm pending arbitration.</p>
    <p><strong>Opt-Out:</strong> You may opt out of the arbitration agreement within 30 days of first using the Service by sending written notice to: STEIMBROS, LLC, 1207 Delaware Ave, Suite 1516, Wilmington, DE 19806.</p>

    <h2>13. GENERAL PROVISIONS</h2>
    <p><strong>Entire Agreement:</strong> These Terms, together with the Privacy Policy and Medical Disclaimer, constitute the entire agreement between you and STEIMBROS, LLC regarding the Service.</p>
    <p><strong>Severability:</strong> If any provision of these Terms is found unenforceable, the remaining provisions will continue in full force and effect.</p>
    <p><strong>No Waiver:</strong> Our failure to enforce any provision of these Terms shall not constitute a waiver of our right to enforce it in the future.</p>
    <p><strong>Assignment:</strong> You may not assign your rights or obligations under these Terms without our prior written consent. We may assign our rights and obligations freely.</p>
    <p><strong>Contact:</strong> STEIMBROS, LLC | 1207 Delaware Ave, Suite 1516, Wilmington, DE 19806 | legal@graceglp.com</p>
  </LegalPageLayout>
);

export default Terms;
