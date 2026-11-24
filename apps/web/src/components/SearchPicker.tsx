import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  ClickAwayListener,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import ClearIcon from '@mui/icons-material/Clear';
import { useStrings } from '../i18n';

export interface SearchPickerOption {
  id: string;
  label: string;
  secondary?: string;
}

export interface SearchPickerResult {
  options: SearchPickerOption[];
  nextCursor: string | null;
}

interface SearchPickerProps {
  label: string;
  placeholder?: string;
  value: SearchPickerOption | null;
  onChange: (option: SearchPickerOption | null) => void;
  /**
   * Server search for one page. `cursor` fetches the next page of the
   * same query; `nextCursor` is null when there are no more results.
   * Results are never silently truncated: when `nextCursor` is set the
   * picker shows a "Load more results" affordance.
   */
  onSearch: (query: string, cursor?: string | null) => Promise<SearchPickerResult>;
  disabled?: boolean;
}

/**
 * Debounced server-search picker for large lists. The caller owns the
 * selected option; typing searches the server (never a preloaded
 * first-100 list), Escape closes the dropdown, and clearing the input
 * clears the selection. Stale responses are ignored as soon as the
 * input changes or clears.
 */
export default function SearchPicker({
  label,
  placeholder,
  value,
  onChange,
  onSearch,
  disabled,
}: SearchPickerProps) {
  const t = useStrings();
  const [input, setInput] = useState(value?.label ?? '');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<SearchPickerOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const requestId = useRef(0);

  // Keep the input in sync when the parent sets or clears the value.
  useEffect(() => {
    setInput(value?.label ?? '');
  }, [value]);

  useEffect(() => {
    const id = ++requestId.current;
    setLoadingMore(false);
    const query = input.trim();
    // Never search for the text of the current selection: after the
    // user picks an option the input holds its label, and searching
    // for it would pop the dropdown back open.
    if (query.length === 0 || (value && query === value.label)) {
      setOptions([]);
      setNextCursor(null);
      setSearched(false);
      setOpen(false);
      setLoading(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setLoading(true);
      void onSearch(query)
        .then((result) => {
          if (requestId.current !== id) return;
          setOptions(result.options);
          setNextCursor(result.nextCursor);
          setSearched(true);
          setOpen(true);
        })
        .catch(() => {
          if (requestId.current !== id) return;
          setOptions([]);
          setNextCursor(null);
          setSearched(true);
          setOpen(true);
        })
        .finally(() => {
          if (requestId.current === id) setLoading(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [input, onSearch, value]);

  const handleLoadMore = () => {
    if (!nextCursor || loadingMore) return;
    const query = input.trim();
    const id = ++requestId.current;
    setLoadingMore(true);
    void onSearch(query, nextCursor)
      .then((result) => {
        // Ignore if the query changed while the page was loading.
        if (requestId.current !== id || input.trim() !== query) return;
        setOptions((current) => [...current, ...result.options]);
        setNextCursor(result.nextCursor);
      })
      .catch(() => {
        // A failed page leaves the existing results and the affordance
        // in place so the user can retry.
      })
      .finally(() => {
        if (requestId.current === id) setLoadingMore(false);
      });
  };

  const handleInput = (text: string) => {
    setInput(text);
    if (value && text !== value.label) onChange(null);
  };

  const handleSelect = (option: SearchPickerOption) => {
    setInput(option.label);
    setOpen(false);
    onChange(option);
  };

  const handleClear = () => {
    setInput('');
    setOptions([]);
    setNextCursor(null);
    setSearched(false);
    setOpen(false);
    onChange(null);
  };

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={{ position: 'relative' }}>
        <TextField
          fullWidth
          label={label}
          placeholder={placeholder ?? t.searchPickerPlaceholder}
          value={input}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => {
            if (options.length > 0 || searched) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          disabled={disabled}
          slotProps={{
            htmlInput: {
              role: 'combobox',
              'aria-expanded': open,
            },
            input: {
              endAdornment: (
                <>
                  {loading && <CircularProgress size={20} aria-label="loading" />}
                  {input.length > 0 && !loading && (
                    <IconButton
                      size="small"
                      aria-label={t.clear}
                      onClick={handleClear}
                      disabled={disabled}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  )}
                </>
              ),
            },
          }}
        />
        {open && (
          <Paper
            sx={{
              position: 'absolute',
              zIndex: 10,
              left: 0,
              right: 0,
              mt: 0.5,
              maxHeight: 280,
              overflow: 'auto',
            }}
          >
            {loading && options.length === 0 ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                <CircularProgress size={20} aria-label="loading" />
              </Box>
            ) : options.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                {t.searchPickerNoResults}
              </Typography>
            ) : (
              <>
                <List role="listbox" dense>
                  {options.map((option) => (
                    <ListItemButton
                      key={option.id}
                      role="option"
                      aria-selected={value?.id === option.id}
                      onClick={() => handleSelect(option)}
                    >
                      <ListItemText primary={option.label} secondary={option.secondary ?? ''} />
                    </ListItemButton>
                  ))}
                </List>
                {nextCursor && (
                  <Box sx={{ p: 1, borderTop: 1, borderColor: 'divider' }}>
                    <Button
                      fullWidth
                      size="small"
                      variant="text"
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                    >
                      {loadingMore ? t.loadingMore : t.loadMoreResults}
                    </Button>
                  </Box>
                )}
              </>
            )}
          </Paper>
        )}
      </Box>
    </ClickAwayListener>
  );
}
