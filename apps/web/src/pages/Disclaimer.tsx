import LegalPageLayout from "@/components/LegalPageLayout";
import SEOHead from "@/components/SEOHead";
import { breadcrumbSchema } from "@/lib/seo-schemas";

const DisclaimerBanner = () => (
  <div className="mb-8 rounded-2xl border-2 border-amber-300/60 bg-amber-50/60 px-6 py-4">
    <p className="text-amber-800 font-semibold text-base m-0">⚠️ Important — please read.</p>
  </div>
);

const Disclaimer = () => (
  <LegalPageLayout banner={<DisclaimerBanner />}>
    <SEOHead
      title="Medical Disclaimer"
      description="grace is a wellness companion, not a medical provider. Read our medical disclaimer about GLP-1 support services."
      canonical="/disclaimer"
      jsonLd={breadcrumbSchema([
        { name: "Home", path: "/" },
        { name: "Medical Disclaimer", path: "/disclaimer" },
      ])}
    />
    <h1>MEDICAL DISCLAIMER AND HEALTH INFORMATION NOTICE</h1>
    <p className="text-muted-foreground text-sm !mt-1 !mb-6">Last Updated: April 12, 2026</p>

    <p><strong>PLEASE READ THIS DISCLAIMER CAREFULLY BEFORE USING GRACE.</strong></p>

    <h2>GRACE IS NOT A MEDICAL SERVICE.</h2>
    <p>STEIMBROS, LLC and the grace SMS service are not a medical provider, healthcare organization, clinical service, pharmacy, or licensed health professional of any kind. We are a wellness habit and motivation tool delivered via text message.</p>
    <p>Nothing in the grace Service — including but not limited to SMS messages, wellness reminders, symptom information, nutritional suggestions, hydration guidance, side effect descriptions, emotional support messages, injection reminders, or any other content — constitutes or should be construed as:</p>
    <ul>
      <li>Medical advice</li>
      <li>Clinical guidance</li>
      <li>Diagnosis of any medical condition</li>
      <li>Treatment recommendation</li>
      <li>Prescription or dosage guidance</li>
      <li>A substitute for consultation with a qualified physician, pharmacist, dietitian, or other licensed healthcare provider</li>
    </ul>

    <h2>YOUR PHYSICIAN IS YOUR MEDICAL AUTHORITY.</h2>
    <p>All decisions regarding your GLP-1 medication, dosage, injection schedule, dose adjustments, and management of side effects must be made in consultation with your prescribing physician or licensed healthcare provider. Do not start, stop, change, or skip your medication based on anything communicated through the grace Service.</p>
    <p>If you experience any medical concern, side effect, or symptom that worries you, contact your doctor or licensed healthcare provider promptly. Do not rely on grace messages as a substitute for that consultation.</p>

    <h2>GRACE DOES NOT PROVIDE DOSAGE OR PRESCRIPTION GUIDANCE.</h2>
    <p>grace injection reminders are timing reminders only, based on the injection day you provide. We do not know your prescribed dosage, your titration schedule, or your specific medical history. We do not provide, and you should not seek from us, any guidance on:</p>
    <ul>
      <li>How much medication to inject</li>
      <li>Whether to increase or decrease your dose</li>
      <li>How to reconstitute compounded medications</li>
      <li>Whether a medication is appropriate for your condition</li>
      <li>Drug interactions with other medications you take</li>
    </ul>
    <p>All of the above must come from your prescribing physician or licensed pharmacist.</p>

    <h2>WELLNESS INFORMATION IS GENERAL IN NATURE.</h2>
    <p>Nutritional information, hydration suggestions, fiber recommendations, protein guidance, and other wellness content delivered through grace are based on generally available public health information and general wellness practices. This information:</p>
    <ul>
      <li>Is not tailored to your individual medical history, conditions, or contraindications</li>
      <li>May not be appropriate for your specific situation</li>
      <li>Is not reviewed or approved by a physician or registered dietitian</li>
      <li>Should not be followed if it conflicts with guidance from your healthcare provider</li>
    </ul>
    <p>Always follow your healthcare provider's specific guidance over any general information provided by grace.</p>

    <h2>SIDE EFFECT INFORMATION IS INFORMATIONAL ONLY.</h2>
    <p>grace may provide general information about commonly reported side effects of GLP-1 medications (such as nausea, fatigue, constipation, or hair changes). This information:</p>
    <ul>
      <li>Is drawn from publicly available sources and general patient experience</li>
      <li>Is provided to help you feel informed and less alone — not to diagnose or treat your symptoms</li>
      <li>Is not a clinical assessment of your specific symptoms</li>
      <li>May not apply to your medication, dose, or health situation</li>
    </ul>
    <p>If you are experiencing side effects that concern you, contact your prescribing physician or healthcare provider. If you are experiencing a medical emergency, call 911 or go to your nearest emergency room immediately.</p>

    <h2>MENTAL HEALTH AND EMOTIONAL SUPPORT LIMITATIONS.</h2>
    <p>grace provides general emotional encouragement and motivational support. We are not a mental health service, therapist, counselor, or crisis service. Our messages are not a substitute for professional mental health care.</p>
    <p>If you are experiencing a mental health crisis, thoughts of self-harm or suicide, or significant emotional distress, please contact:</p>
    <ul>
      <li><strong>988 Suicide and Crisis Lifeline:</strong> Call or text 988</li>
      <li><strong>Crisis Text Line:</strong> Text HOME to 741741</li>
      <li><strong>Emergency Services:</strong> Call 911</li>
    </ul>
    <p>Do not rely on grace messages during a mental health emergency.</p>

    <h2>NO DOCTOR-PATIENT RELATIONSHIP.</h2>
    <p>Use of the grace Service does not create a doctor-patient relationship, a therapist-client relationship, or any other professional healthcare relationship between you and STEIMBROS, LLC or any of its employees, contractors, or agents.</p>

    <h2>ACCURACY OF INFORMATION.</h2>
    <p>While we make reasonable efforts to ensure the general wellness information provided through grace is accurate and up-to-date, we make no warranties or representations regarding the accuracy, completeness, or currentness of any information. Medical knowledge and GLP-1 research evolve rapidly. Information that is accurate today may be outdated tomorrow. Always verify wellness and health information with a qualified professional.</p>

    <h2>YOUR RESPONSIBILITY.</h2>
    <p>By using the grace Service, you acknowledge and agree that:</p>
    <ul>
      <li>You are solely responsible for your health decisions</li>
      <li>You will consult with your prescribing physician or healthcare provider regarding all medical decisions</li>
      <li>You will not use grace as a substitute for professional medical care</li>
      <li>You have read and understood this Medical Disclaimer in its entirety</li>
      <li>You use the Service voluntarily and at your own risk</li>
    </ul>

    <h2>CONTACT</h2>
    <p>If you have questions about this disclaimer, contact us at:</p>
    <p>STEIMBROS, LLC<br />1207 Delaware Ave, Suite 1516<br />Wilmington, DE 19806<br />legal@graceglp.com</p>
  </LegalPageLayout>
);

export default Disclaimer;
