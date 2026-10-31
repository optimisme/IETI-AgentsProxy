#!/usr/bin/env python3
"""Unchanged representative/functional suite, then a separate cold serial diagnostic."""
import run_representative_quality
import run_project_known_misses
if __name__=='__main__':
    run_representative_quality.main()
    run_project_known_misses.main()
