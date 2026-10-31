# Recorded GPU trial tables

Generated from `analysis.json`; individual runs and incomplete trials remain visible.

| Run | Stage | Full trial | Wall s | TTFT p50/p95 s | Output tok/s | Output overlap | Queue p95 s | Min free GiB | Host pageouts | Strict / bounded |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| baseline-1 | capacity-cold16 | False | 646.74 | 447.38 / 596.18 | 22.17 | 14 | 547.96 | 9.54 | 1 | False / False |
| baseline-capacity-1 | capacity-cold16 | True | 642.41 | 439.99 / 588.02 | 22.32 | 13 | 522.92 | 11.37 | 0 | True / True |
| baseline-capacity-1 | capacity-return1-16 | True | 407.91 | 92.81 / 350.26 | 35.15 | 12 | 232.56 | 12.12 | 0 | True / True |
| baseline-capacity-1 | capacity-return2-16 | True | 377.08 | 92.57 / 342.57 | 38.02 | 10 | 181.91 | 12.30 | 0 | True / True |
| baseline-capacity-2 | capacity-cold16 | True | 635.42 | 472.85 / 581.88 | 22.56 | 14 | 533.54 | 10.28 | 0 | True / True |
| baseline-capacity-2 | capacity-return1-16 | True | 407.37 | 111.26 / 342.52 | 35.19 | 12 | 255.28 | 11.24 | 0 | True / True |
| baseline-capacity-2 | capacity-return2-16 | True | 377.25 | 110.54 / 341.43 | 38.00 | 10 | 177.67 | 11.64 | 0 | True / True |
| baseline-capacity-3 | capacity-cold16 | True | 641.73 | 440.33 / 587.56 | 22.34 | 13 | 508.88 | 11.34 | 0 | True / True |
| baseline-capacity-3 | capacity-return1-16 | True | 481.70 | 223.78 / 419.09 | 29.76 | 9 | 256.70 | 12.74 | 0 | True / True |
| baseline-capacity-3 | capacity-return2-16 | True | 416.88 | 156.88 / 384.09 | 34.39 | 8 | 178.23 | 12.82 | 0 | True / True |
| baseline-representative-1 | conversation16-0 | True | 73.24 | 20.76 / 44.38 | 27.96 | 15 | 0.25 | 25.84 | 0 | True / True |
| baseline-representative-1 | conversation16-1 | True | 13.61 | 1.43 / 1.94 | 150.48 | 16 | 0.16 | 24.04 | 0 | True / True |
| baseline-representative-1 | conversation16-2 | True | 12.62 | 1.57 / 2.10 | 162.29 | 16 | 0.20 | 22.20 | 0 | True / True |
| baseline-representative-1 | fairness16 | True | 48.72 | 1.58 / 28.32 | 84.07 | 16 | 0.32 | 22.41 | 0 | True / True |
| baseline-representative-1 | short16-0 | True | 12.29 | 0.80 / 0.86 | 333.27 | 16 | 0.24 | 28.43 | 0 | True / True |
| baseline-representative-1 | short16-1 | True | 11.54 | 0.69 / 0.74 | 355.04 | 16 | 0.23 | 28.39 | 0 | True / True |
| baseline-representative-1 | short16-2 | True | 10.89 | 0.67 / 0.73 | 376.19 | 16 | 0.22 | 28.63 | 0 | True / True |
| baseline-sustained-1 | sustained-cold16 | False | 614.86 | 453.52 / 559.41 | 23.32 | 14 | 518.38 | 10.99 | 0 | True / True |
| baseline-sustained-1 | sustained-return1-16 | False | 487.13 | 267.45 / 419.41 | 29.43 | 13 | 336.63 | 10.44 | 0 | True / True |
| baseline-sustained-1 | sustained-return2-16 | False | 430.06 | 97.90 / 381.09 | 29.17 | 10 | 251.32 | 11.05 | 0 | False / False |
| candidate-capacity-1 | capacity-cold16 | True | 687.28 | 370.30 / 617.79 | 20.86 | 11 | 1.43 | 8.32 | 1 | False / True |
| candidate-capacity-1 | capacity-return1-16 | True | 76.73 | 1.90 / 1.94 | 186.83 | 16 | 0.67 | 7.21 | 0 | True / True |
| candidate-capacity-1 | capacity-return2-16 | True | 37.76 | 2.29 / 2.32 | 379.63 | 16 | 0.95 | 6.88 | 1 | False / True |
| candidate-capacity-2 | capacity-cold16 | True | 680.11 | 366.57 / 612.66 | 21.08 | 10 | 1.22 | 8.34 | 0 | True / True |
| candidate-capacity-2 | capacity-return1-16 | True | 77.91 | 2.18 / 2.22 | 184.01 | 16 | 0.78 | 7.27 | 1 | False / True |
| candidate-capacity-2 | capacity-return2-16 | True | 37.46 | 2.09 / 2.11 | 382.72 | 16 | 0.91 | 7.20 | 0 | True / True |
| candidate-capacity-3 | capacity-cold16 | True | 678.05 | 366.02 / 611.54 | 21.14 | 11 | 1.18 | 8.39 | 0 | True / True |
| candidate-capacity-3 | capacity-return1-16 | True | 75.23 | 2.60 / 2.64 | 190.56 | 16 | 0.72 | 6.77 | 0 | True / True |
| candidate-capacity-3 | capacity-return2-16 | True | 37.64 | 2.24 / 2.27 | 380.84 | 16 | 0.84 | 6.75 | 0 | True / True |
| candidate-growth65k-qualification1 | growth65k-cold16 | True | 594.39 | 317.03 / 530.60 | 24.12 | 11 | 1.04 | 7.96 | 0 | True / True |
| candidate-growth65k-qualification1 | growth65k-return1-16 | True | 221.26 | 8.47 / 131.51 | 64.79 | 16 | 0.76 | 7.82 | 0 | True / True |
| candidate-representative-1 | conversation16-0 | True | 73.35 | 10.22 / 42.50 | 27.92 | 15 | 0.23 | 27.41 | 0 | True / True |
| candidate-representative-1 | conversation16-1 | True | 13.31 | 1.42 / 1.97 | 153.89 | 16 | 0.13 | 26.26 | 0 | True / True |
| candidate-representative-1 | conversation16-2 | True | 13.47 | 3.16 / 3.35 | 152.02 | 16 | 0.15 | 24.93 | 0 | True / True |
| candidate-representative-1 | fairness16 | True | 47.59 | 1.61 / 27.48 | 86.07 | 16 | 0.32 | 25.03 | 0 | True / True |
| candidate-representative-1 | short16-0 | True | 11.95 | 0.76 / 0.82 | 342.80 | 16 | 0.21 | 28.69 | 0 | True / True |
| candidate-representative-1 | short16-1 | True | 11.31 | 0.67 / 0.72 | 362.29 | 16 | 0.23 | 28.58 | 0 | True / True |
| candidate-representative-1 | short16-2 | True | 10.84 | 0.67 / 0.72 | 378.01 | 16 | 0.21 | 28.67 | 0 | True / True |
| candidate-sustained-qualification2 | sustained-cold16 | True | 653.92 | 352.31 / 585.75 | 21.92 | 11 | 1.18 | 8.41 | 0 | True / True |
| candidate-sustained-qualification2 | sustained-return1-16 | True | 95.62 | 9.09 / 12.07 | 149.92 | 16 | 0.89 | 8.14 | 0 | True / True |
| candidate-sustained-qualification2 | sustained-return2-16 | True | 92.21 | 8.45 / 11.21 | 155.47 | 16 | 0.68 | 8.12 | 0 | True / True |
| candidate-sustained-qualification2 | sustained-return3-16 | True | 87.22 | 7.21 / 9.41 | 164.36 | 16 | 0.65 | 8.17 | 1 | False / True |
| candidate-sustained-qualification3 | sustained-cold16 | True | 653.02 | 351.49 / 584.52 | 21.95 | 10 | 1.19 | 8.73 | 0 | True / True |
| candidate-sustained-qualification3 | sustained-return1-16 | True | 94.80 | 9.61 / 12.55 | 151.22 | 16 | 0.74 | 8.28 | 0 | True / True |
| candidate-sustained-qualification3 | sustained-return2-16 | True | 92.94 | 8.58 / 11.33 | 154.24 | 16 | 0.89 | 8.12 | 0 | True / True |
| candidate-sustained-qualification3 | sustained-return3-16 | True | 86.93 | 7.14 / 9.37 | 164.91 | 16 | 0.88 | 8.12 | 0 | True / True |
| release-untraced-capacity1 | capacity-cold16 | True | 677.57 | 364.57 / 609.96 | 21.16 | 10 | — | 8.47 | 0 | True / True |
| release-untraced-capacity1 | capacity-return1-16 | True | 77.23 | 2.88 / 2.94 | 185.63 | 16 | — | 7.10 | 33 | False / True |
| release-untraced-capacity1 | capacity-return2-16 | True | 37.25 | 2.01 / 2.05 | 384.86 | 16 | — | 7.03 | 0 | True / True |
| release-untraced-representative1 | conversation16-0 | True | 72.75 | 10.13 / 42.19 | 28.15 | 15 | — | 27.42 | 0 | True / True |
| release-untraced-representative1 | conversation16-1 | True | 13.62 | 1.33 / 1.86 | 150.39 | 16 | — | 26.32 | 0 | True / True |
| release-untraced-representative1 | conversation16-2 | True | 13.70 | 2.99 / 3.18 | 149.54 | 16 | — | 25.12 | 0 | True / True |
| release-untraced-representative1 | fairness16 | True | 47.91 | 1.54 / 27.31 | 85.49 | 16 | — | 25.87 | 0 | True / True |
| release-untraced-representative1 | short16-0 | True | 12.15 | 0.68 / 0.74 | 337.22 | 16 | — | 28.22 | 0 | True / True |
| release-untraced-representative1 | short16-1 | True | 11.34 | 0.54 / 0.59 | 361.30 | 16 | — | 28.25 | 0 | True / True |
| release-untraced-representative1 | short16-2 | True | 10.69 | 0.54 / 0.59 | 383.03 | 16 | — | 28.60 | 0 | True / True |
| release-untraced-sustained1 | sustained-cold16 | True | 651.19 | 349.92 / 583.01 | 22.01 | 11 | — | 8.75 | 0 | True / True |
| release-untraced-sustained1 | sustained-return1-16 | True | 95.71 | 9.19 / 12.17 | 149.79 | 16 | — | 8.34 | 0 | True / True |
| release-untraced-sustained1 | sustained-return2-16 | True | 92.47 | 8.30 / 11.04 | 155.04 | 16 | — | 8.34 | 0 | True / True |
| release-untraced-sustained1 | sustained-return3-16 | True | 87.09 | 6.87 / 9.06 | 164.61 | 16 | — | 8.07 | 34 | False / True |
| reserve8-screen1 | capacity-cold16 | False | 623.62 | 542.71 / 543.09 | 22.99 | 16 | 2.83 | 6.54 | 39 | False / False |
| reserve8adaptive-sustained-screen1 | sustained-cold16 | False | 600.68 | 517.99 / 520.43 | 23.87 | 16 | 1.16 | 9.28 | 0 | True / True |
| reserve8adaptive-sustained-screen1 | sustained-return1-16 | False | 95.41 | 9.94 / 12.82 | 150.26 | 16 | 0.73 | 9.09 | 1 | False / True |
| reserve8adaptive-sustained-screen1 | sustained-return2-16 | False | 95.77 | 8.66 / 11.60 | 149.69 | 16 | 0.92 | 6.15 | 1 | False / True |
| reserve8coalesced-screen2 | capacity-cold16 | True | 617.01 | 541.20 / 541.44 | 23.23 | 16 | 1.21 | 7.55 | 0 | True / False |
| reserve8coalesced-screen2 | capacity-return1-16 | True | 78.54 | 2.35 / 2.38 | 182.54 | 16 | 0.75 | 6.54 | 1 | False / True |
| reserve8coalesced-screen2 | capacity-return2-16 | True | 37.42 | 2.12 / 2.15 | 383.14 | 16 | 0.87 | 6.35 | 0 | True / True |
| reserve8tail-sustained-screen1 | sustained-cold16 | True | 600.08 | 516.75 / 519.19 | 23.89 | 16 | 1.25 | 8.36 | 0 | True / True |
| reserve8tail-sustained-screen1 | sustained-return1-16 | True | 96.03 | 9.96 / 12.96 | 149.28 | 16 | 0.69 | 8.04 | 1 | False / True |
| reserve8tail-sustained-screen1 | sustained-return2-16 | True | 93.38 | 8.68 / 11.70 | 153.53 | 16 | 0.75 | 8.02 | 0 | True / True |
| reserve8tail-sustained-screen1 | sustained-return3-16 | True | 87.56 | 7.09 / 9.32 | 163.74 | 16 | 0.67 | 8.04 | 1 | False / True |
| reserve8tailorder64-sustained-screen1 | sustained-cold16 | True | 657.30 | 354.12 / 587.98 | 21.81 | 10 | 1.56 | 8.74 | 1 | False / True |
| reserve8tailorder64-sustained-screen1 | sustained-return1-16 | True | 96.91 | 9.96 / 13.11 | 147.94 | 16 | 0.60 | 8.05 | 0 | True / True |
| reserve8tailorder64-sustained-screen1 | sustained-return2-16 | True | 92.47 | 8.66 / 11.65 | 155.04 | 16 | 0.79 | 8.06 | 1 | False / True |
| reserve8tailorder64-sustained-screen1 | sustained-return3-16 | True | 87.52 | 6.98 / 9.20 | 163.81 | 16 | 0.81 | 8.28 | 0 | True / True |

## Matched primary changes

Negative latency/wall changes are improvements; positive throughput changes are improvements.

| Analysis | Stage | Metric | Pairs | Median change % | Min/max % |
|---|---|---|---:|---:|---:|
| strict_zero_host_swap | capacity-cold16 | wall_s | 2 | 6.35 | 5.66 / 7.03 |
| strict_zero_host_swap | capacity-cold16 | aggregate_output_tok_s | 2 | -5.96 | -6.57 / -5.36 |
| strict_zero_host_swap | capacity-cold16 | ttft_p50_s | 2 | -19.68 | -22.48 / -16.88 |
| strict_zero_host_swap | capacity-cold16 | ttft_p95_s | 2 | 4.69 | 4.08 / 5.29 |
| strict_zero_host_swap | capacity-cold16 | sse_gap_p95_per_user_median_s | 2 | 3.18 | 2.28 / 4.09 |
| strict_zero_host_swap | capacity-cold16 | worst_sse_gap_s | 2 | 3.42 | 2.33 / 4.52 |
| strict_zero_host_swap | capacity-cold16 | queue_p95_s | 2 | -99.77 | -99.77 / -99.77 |
| strict_zero_host_swap | capacity-cold16 | post_first_token_per_token_p50_s | 2 | 112.06 | 100.49 / 123.63 |
| strict_zero_host_swap | capacity-cold16 | completion_p50_s | 2 | 9.57 | 6.96 / 12.18 |
| strict_zero_host_swap | capacity-cold16 | completion_p95_s | 2 | 5.84 | 5.09 / 6.59 |
| strict_zero_host_swap | capacity-return1-16 | wall_s | 2 | -82.79 | -84.38 / -81.19 |
| strict_zero_host_swap | capacity-return1-16 | aggregate_output_tok_s | 2 | 485.94 | 431.59 / 540.30 |
| strict_zero_host_swap | capacity-return1-16 | ttft_p50_s | 2 | -98.40 | -98.84 / -97.95 |
| strict_zero_host_swap | capacity-return1-16 | ttft_p95_s | 2 | -99.41 | -99.45 / -99.37 |
| strict_zero_host_swap | capacity-return1-16 | sse_gap_p95_per_user_median_s | 2 | -75.87 | -76.00 / -75.74 |
| strict_zero_host_swap | capacity-return1-16 | worst_sse_gap_s | 2 | -68.69 | -70.19 / -67.19 |
| strict_zero_host_swap | capacity-return1-16 | queue_p95_s | 2 | -99.72 | -99.72 / -99.71 |
| strict_zero_host_swap | capacity-return1-16 | post_first_token_per_token_p50_s | 2 | -73.18 | -73.84 / -72.52 |
| strict_zero_host_swap | capacity-return1-16 | completion_p50_s | 2 | -85.46 | -87.07 / -83.85 |
| strict_zero_host_swap | capacity-return1-16 | completion_p95_s | 2 | -83.18 | -84.76 / -81.60 |
| strict_zero_host_swap | capacity-return2-16 | wall_s | 2 | -90.52 | -90.97 / -90.07 |
| strict_zero_host_swap | capacity-return2-16 | aggregate_output_tok_s | 2 | 957.29 | 907.13 / 1007.45 |
| strict_zero_host_swap | capacity-return2-16 | ttft_p50_s | 2 | -98.34 | -98.57 / -98.11 |
| strict_zero_host_swap | capacity-return2-16 | ttft_p95_s | 2 | -99.40 | -99.41 / -99.38 |
| strict_zero_host_swap | capacity-return2-16 | sse_gap_p95_per_user_median_s | 2 | -80.87 | -80.90 / -80.83 |
| strict_zero_host_swap | capacity-return2-16 | worst_sse_gap_s | 2 | -67.89 | -69.76 / -66.03 |
| strict_zero_host_swap | capacity-return2-16 | queue_p95_s | 2 | -99.51 | -99.53 / -99.49 |
| strict_zero_host_swap | capacity-return2-16 | post_first_token_per_token_p50_s | 2 | -80.57 | -80.67 / -80.47 |
| strict_zero_host_swap | capacity-return2-16 | completion_p50_s | 2 | -88.34 | -89.11 / -87.57 |
| strict_zero_host_swap | capacity-return2-16 | completion_p95_s | 2 | -90.71 | -91.16 / -90.26 |
| bounded_background_noise | capacity-cold16 | wall_s | 3 | 6.98 | 5.66 / 7.03 |
| bounded_background_noise | capacity-cold16 | aggregate_output_tok_s | 3 | -6.53 | -6.57 / -5.36 |
| bounded_background_noise | capacity-cold16 | ttft_p50_s | 3 | -16.88 | -22.48 / -15.84 |
| bounded_background_noise | capacity-cold16 | ttft_p95_s | 3 | 5.06 | 4.08 / 5.29 |
| bounded_background_noise | capacity-cold16 | sse_gap_p95_per_user_median_s | 3 | 4.09 | 2.28 / 5.02 |
| bounded_background_noise | capacity-cold16 | worst_sse_gap_s | 3 | 2.33 | -13.23 / 4.52 |
| bounded_background_noise | capacity-cold16 | queue_p95_s | 3 | -99.77 | -99.77 / -99.73 |
| bounded_background_noise | capacity-cold16 | post_first_token_per_token_p50_s | 3 | 118.95 | 100.49 / 123.63 |
| bounded_background_noise | capacity-cold16 | completion_p50_s | 3 | 12.18 | 6.96 / 14.54 |
| bounded_background_noise | capacity-cold16 | completion_p95_s | 3 | 6.59 | 5.09 / 7.13 |
| bounded_background_noise | capacity-return1-16 | wall_s | 3 | -81.19 | -84.38 / -80.88 |
| bounded_background_noise | capacity-return1-16 | aggregate_output_tok_s | 3 | 431.59 | 422.89 / 540.30 |
| bounded_background_noise | capacity-return1-16 | ttft_p50_s | 3 | -98.04 | -98.84 / -97.95 |
| bounded_background_noise | capacity-return1-16 | ttft_p95_s | 3 | -99.37 | -99.45 / -99.35 |
| bounded_background_noise | capacity-return1-16 | sse_gap_p95_per_user_median_s | 3 | -75.81 | -76.00 / -75.74 |
| bounded_background_noise | capacity-return1-16 | worst_sse_gap_s | 3 | -67.19 | -70.19 / -65.71 |
| bounded_background_noise | capacity-return1-16 | queue_p95_s | 3 | -99.71 | -99.72 / -99.70 |
| bounded_background_noise | capacity-return1-16 | post_first_token_per_token_p50_s | 3 | -73.84 | -74.76 / -72.52 |
| bounded_background_noise | capacity-return1-16 | completion_p50_s | 3 | -83.95 | -87.07 / -83.85 |
| bounded_background_noise | capacity-return1-16 | completion_p95_s | 3 | -81.60 | -84.76 / -81.10 |
| bounded_background_noise | capacity-return2-16 | wall_s | 3 | -90.07 | -90.97 / -89.99 |
| bounded_background_noise | capacity-return2-16 | aggregate_output_tok_s | 3 | 907.13 | 898.53 / 1007.45 |
| bounded_background_noise | capacity-return2-16 | ttft_p50_s | 3 | -98.11 | -98.57 / -97.52 |
| bounded_background_noise | capacity-return2-16 | ttft_p95_s | 3 | -99.38 | -99.41 / -99.32 |
| bounded_background_noise | capacity-return2-16 | sse_gap_p95_per_user_median_s | 3 | -80.90 | -81.03 / -80.83 |
| bounded_background_noise | capacity-return2-16 | worst_sse_gap_s | 3 | -68.80 | -69.76 / -66.03 |
| bounded_background_noise | capacity-return2-16 | queue_p95_s | 3 | -99.49 | -99.53 / -99.48 |
| bounded_background_noise | capacity-return2-16 | post_first_token_per_token_p50_s | 3 | -80.67 | -80.91 / -80.47 |
| bounded_background_noise | capacity-return2-16 | completion_p50_s | 3 | -87.57 | -89.11 / -86.65 |
| bounded_background_noise | capacity-return2-16 | completion_p95_s | 3 | -90.26 | -91.16 / -90.18 |

## Whole matched timing sequence

| Pair | Eligible strict / bounded | Baseline s | Candidate s | Wall change % | Throughput change % |
|---|---|---:|---:|---:|---:|
| capacity-1 | False / True | 1427.40 | 801.78 | -43.83 | 78.03 |
| capacity-2 | False / True | 1420.04 | 795.48 | -43.98 | 78.51 |
| capacity-3 | True / True | 1540.30 | 790.93 | -48.65 | 94.75 |

## Separate functional recall

| Run | Passed |
|---|---:|
| baseline-capacity-2 | 16/16 |
| baseline-capacity-3 | 16/16 |
| baseline-representative-1 | 16/16 |
| baseline-representative-1 | 0/1 |
| baseline-representative-1 | 0/1 |
| baseline-representative-1 | 0/1 |
| candidate-capacity-1 | 16/16 |
| candidate-capacity-2 | 16/16 |
| candidate-capacity-3 | 16/16 |
| candidate-representative-1 | 16/16 |
| candidate-representative-1 | 0/1 |
| candidate-representative-1 | 0/1 |
| candidate-representative-1 | 0/1 |
| candidate-sustained-qualification2 | 13/16 |
| candidate-sustained-qualification3 | 13/16 |
| release-untraced-capacity1 | 16/16 |
| release-untraced-representative1 | 16/16 |
| release-untraced-representative1 | 0/1 |
| release-untraced-representative1 | 0/1 |
| release-untraced-representative1 | 0/1 |
| release-untraced-sustained1 | 13/16 |
| reserve8tailorder64-sustained-screen1 | 13/16 |

Strict means zero whole-host swap-out. Bounded allows at most 256 host pages (1 MiB),
with full main-serving-process counter coverage and zero observed main-process CPU VmSwap.
Both require full outputs, no unrelated requests or OOM. Primary aggregates additionally
require both complete trials, identical payload/token/fixture hashes, common instrumentation,
image, installed package versions/source hashes and common serving settings.
A raw stage timing from a failed trial does not qualify that configuration.
