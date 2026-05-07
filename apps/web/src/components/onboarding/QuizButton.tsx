interface QuizButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}

const QuizButton = ({ onClick, disabled, children, variant = "primary" }: QuizButtonProps) => {
  if (variant === "secondary") {
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        className="w-full h-16 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-full text-lg font-medium tracking-wide transition-all duration-300 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {children}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full h-16 bg-primary hover:brightness-95 text-primary-foreground rounded-full text-lg font-medium tracking-wide transition-all duration-300 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
};

export default QuizButton;