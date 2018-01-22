#!/usr/bin/env bash
cd /data
latexmk -f -pdf -xelatex -r "/glossaries.latexmk" -shell-escape -interaction=nonstopmode -halt-on-error "$@"
