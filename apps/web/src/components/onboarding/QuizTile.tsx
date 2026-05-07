interface QuizTileProps {
  label: string;
  subtitle?: string;
  selected: boolean;
  onClick: () => void;
  onAutoAdvance?: () => void;
  index?: number;
  multiSelect?: boolean;
}

const QuizTile = ({ label, subtitle, selected, onClick, onAutoAdvance, multiSelect = false }: QuizTileProps) => {
  const handleClick = () => {
    onClick();
    if (onAutoAdvance) {
      setTimeout(onAutoAdvance, 350);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`
        w-full text-left min-h-[4rem] rounded-2xl border-2 p-5 flex items-start gap-4 transition-all duration-200
        ${selected
          ? "border-primary bg-background/50"
          : "border-sand hover:border-accent hover:bg-background/50"
        }
      `}
    >
      {/* Radio/Check indicator */}
      <div className={`
        shrink-0 w-6 h-6 rounded-full transition-all duration-200 mt-0.5 flex items-center justify-center
        ${selected
          ? multiSelect
            ? "border-2 border-primary bg-primary"
            : "border-[6px] border-primary bg-card"
          : "border-2 border-sand bg-card"
        }
      `}>
        {selected && multiSelect && (
          <svg className="w-3.5 h-3.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      <div className="flex-grow min-w-0">
        <span className="block text-lg font-medium leading-snug text-foreground">
          {label}
        </span>
        {subtitle && (
          <span className="block text-sm text-muted-foreground mt-0.5">{subtitle}</span>
        )}
      </div>
    </button>
  );
};

export default QuizTile;
