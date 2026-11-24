import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { useState } from 'react';
import SearchPicker, { type SearchPickerOption, type SearchPickerResult } from './SearchPicker';

const OPTIONS: SearchPickerOption[] = [
  { id: 'c1', label: 'Ahmed', secondary: '0100' },
  { id: 'c2', label: 'Sara', secondary: '0200' },
];

function pageResult(options: SearchPickerOption[], nextCursor: string | null): SearchPickerResult {
  return { options, nextCursor };
}

describe('SearchPicker', () => {
  afterEach(() => {
    cleanup();
  });

  function renderPicker(
    onSearch: (q: string, cursor?: string | null) => Promise<SearchPickerResult>,
  ) {
    const onChange = vi.fn();
    function StatefulPicker() {
      const [value, setValue] = useState<SearchPickerOption | null>(null);
      return (
        <SearchPicker
          label="Customer"
          value={value}
          onChange={(option) => {
            setValue(option);
            onChange(option);
          }}
          onSearch={onSearch}
        />
      );
    }
    const utils = render(<StatefulPicker />);
    return { ...utils, onChange };
  }

  it('debounces the search and shows server results', async () => {
    const onSearch = vi.fn().mockResolvedValue(pageResult(OPTIONS, null));
    renderPicker(onSearch);
    fireEvent.change(screen.getByRole('combobox', { name: 'Customer' }), {
      target: { value: 'Ah' },
    });
    // Debounced: not called synchronously.
    expect(onSearch).not.toHaveBeenCalled();
    expect(await screen.findByRole('option', { name: /Ahmed/ })).toBeInTheDocument();
    expect(onSearch).toHaveBeenCalledWith('Ah');
    expect(screen.getByRole('option', { name: /Sara/ })).toBeInTheDocument();
  });

  it('selects an option and reports it', async () => {
    const onSearch = vi.fn().mockResolvedValue(pageResult(OPTIONS, null));
    const { onChange } = renderPicker(onSearch);
    fireEvent.change(screen.getByRole('combobox', { name: 'Customer' }), {
      target: { value: 'Ah' },
    });
    fireEvent.click(await screen.findByRole('option', { name: /Ahmed/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(OPTIONS[0]));
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('Ahmed');
    expect(screen.queryByRole('option', { name: /Ahmed/ })).not.toBeInTheDocument();
    // The dropdown must stay closed after the pick: the input now holds
    // the selected label, which must not trigger a new search.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByRole('option', { name: /Ahmed/ })).not.toBeInTheDocument();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('clears the selection', async () => {
    const onSearch = vi.fn().mockResolvedValue(pageResult(OPTIONS, null));
    const { onChange } = renderPicker(onSearch);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(input, { target: { value: 'Ah' } });
    fireEvent.click(await screen.findByRole('option', { name: /Ahmed/ }));
    expect(onChange).toHaveBeenCalledWith(OPTIONS[0]);
    expect(input).toHaveValue('Ahmed');
    // The parent applies the selection; clearing must report null.
    fireEvent.click(screen.getByRole('button', { name: 'مسح' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('');
  });

  it('closes the dropdown on Escape', async () => {
    const onSearch = vi.fn().mockResolvedValue(pageResult(OPTIONS, null));
    renderPicker(onSearch);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(input, { target: { value: 'Ah' } });
    expect(await screen.findByRole('option', { name: /Ahmed/ })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /Ahmed/ })).not.toBeInTheDocument(),
    );
  });

  it('ignores an in-flight search after the input is cleared', async () => {
    let finish!: (result: SearchPickerResult) => void;
    const onSearch = vi.fn(
      () =>
        new Promise<SearchPickerResult>((resolve) => {
          finish = resolve;
        }),
    );
    renderPicker(onSearch);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(input, { target: { value: 'Ah' } });
    await waitFor(() => expect(onSearch).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: '' } });
    finish(pageResult(OPTIONS, null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('option', { name: /Ahmed/ })).not.toBeInTheDocument();
  });

  it('shows no results when the search comes back empty', async () => {
    const onSearch = vi.fn().mockResolvedValue(pageResult([], null));
    renderPicker(onSearch);
    fireEvent.change(screen.getByRole('combobox', { name: 'Customer' }), {
      target: { value: 'zzz' },
    });
    expect(await screen.findByText('لا توجد نتائج.')).toBeInTheDocument();
  });

  it('shows "Load more results" only when a next page exists, and appends it', async () => {
    const page1 = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i + 1}`,
      label: `Customer ${i + 1}`,
    }));
    const page2 = [{ id: 'c11', label: 'Customer 11' }];
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce(pageResult(page1, 'cursor-2'))
      .mockResolvedValueOnce(pageResult(page2, null));
    renderPicker(onSearch);
    fireEvent.change(screen.getByRole('combobox', { name: 'Customer' }), {
      target: { value: 'Customer' },
    });
    expect(await screen.findByRole('option', { name: 'Customer 1' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Customer 10' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Customer 11' })).not.toBeInTheDocument();
    // A full page with a next cursor: the continuation affordance is visible.
    const loadMore = screen.getByRole('button', { name: 'عرض المزيد من النتائج' });
    fireEvent.click(loadMore);
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('Customer', 'cursor-2'));
    expect(await screen.findByRole('option', { name: 'Customer 11' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Customer 1' })).toBeInTheDocument();
    // The second page had no next cursor: the affordance is gone.
    expect(screen.queryByRole('button', { name: 'عرض المزيد من النتائج' })).not.toBeInTheDocument();
  });

  it('hides the continuation affordance when the first page is the last', async () => {
    const onSearch = vi.fn().mockResolvedValue(pageResult(OPTIONS, null));
    renderPicker(onSearch);
    fireEvent.change(screen.getByRole('combobox', { name: 'Customer' }), {
      target: { value: 'Ah' },
    });
    expect(await screen.findByRole('option', { name: /Ahmed/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'عرض المزيد من النتائج' })).not.toBeInTheDocument();
  });
});
