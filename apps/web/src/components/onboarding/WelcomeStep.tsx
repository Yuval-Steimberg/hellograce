import QuizButton from "./QuizButton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import avatar1 from "../../../public/avatars/avatar-1.jpg";
import avatar2 from "../../../public/avatars/avatar-2.jpg";
import avatar3 from "../../../public/avatars/avatar-3.jpg";
import avatar4 from "../../../public/avatars/avatar-4.jpg";

interface WelcomeStepProps {
  onNext: () => void;
}

const WelcomeStep = ({ onNext }: WelcomeStepProps) => {
  return (
    <article>
      <div className="flex-1 flex flex-col justify-center pt-8">
        <span className="uppercase tracking-widest text-xs font-semibold text-muted-foreground/60 block mb-4" aria-label="Welcome to grace">
          Welcome to grace
        </span>
        <h1 className="text-4xl font-serif text-foreground tracking-tight leading-[1.1] mb-5">
          Hi, I'm Grace 🤍
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          I'll be your friend through this GLP-1 journey — right here in your texts, no app to open. Someone who remembers you, checks in on the good days and the hard ones, and actually gets it. Let's get to know each other.
        </p>

        {/* Social Proof */}
        <div className="mt-8 flex items-center gap-4" role="group" aria-label="Community members">
          <div className="flex -space-x-3">
            <Avatar className="h-10 w-10 border-2 border-background ring-0">
              <AvatarImage src={avatar1} alt="grace community member" className="object-cover" width={40} height={40} />
              <AvatarFallback className="bg-[hsl(15,50%,75%)] text-foreground text-sm font-medium">U1</AvatarFallback>
            </Avatar>
            <Avatar className="h-10 w-10 border-2 border-background ring-0">
              <AvatarImage src={avatar2} alt="grace community member" className="object-cover" width={40} height={40} />
              <AvatarFallback className="bg-[hsl(25,45%,70%)] text-foreground text-sm font-medium">U2</AvatarFallback>
            </Avatar>
            <Avatar className="h-10 w-10 border-2 border-background ring-0">
              <AvatarImage src={avatar3} alt="grace community member" className="object-cover" width={40} height={40} />
              <AvatarFallback className="bg-[hsl(10,40%,65%)] text-white text-sm font-medium">U3</AvatarFallback>
            </Avatar>
            <Avatar className="h-10 w-10 border-2 border-background ring-0">
              <AvatarImage src={avatar4} alt="grace community member" className="object-cover" width={40} height={40} />
              <AvatarFallback className="bg-[hsl(35,42%,72%)] text-foreground text-sm font-medium">U4</AvatarFallback>
            </Avatar>
          </div>
          <p className="text-sm text-muted-foreground leading-snug">
            <span className="font-semibold text-foreground">12,000+ women</span> on their GLP-1 journey
          </p>
        </div>
      </div>
      <div className="mt-auto pt-12 pb-8 flex flex-col items-center gap-3">
        <QuizButton onClick={onNext}>Continue</QuizButton>
      </div>
    </article>
  );
};

export default WelcomeStep;