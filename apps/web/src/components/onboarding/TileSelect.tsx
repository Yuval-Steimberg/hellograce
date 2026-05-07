import { motion } from "framer-motion";
import { Check } from "lucide-react";

interface TileSelectProps {
  options: string[];
  selected: string | string[];
  onSelect: (value: string) => void;
  multiSelect?: boolean;
  columns?: 2 | 3;
}

const TileSelect = ({ options, selected, onSelect, multiSelect = false, columns = 2 }: TileSelectProps) => {
  const isSelected = (option: string) =>
    multiSelect ? (selected as string[]).includes(option) : selected === option;

  return (
    <div className={`grid gap-3 ${columns === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
      {options.map((option, i) => (
        <motion.button
          key={option}
          type="button"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="nudge-tile"
          data-selected={isSelected(option)}
          onClick={() => onSelect(option)}
        >
          {isSelected(option) && (
            <Check className="absolute right-2 top-2 h-4 w-4 text-primary" />
          )}
          {option}
        </motion.button>
      ))}
    </div>
  );
};

export default TileSelect;