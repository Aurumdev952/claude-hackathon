"""External synthetic sources (v3 plan §5a): national cancer registry history, DHS/STEPS-style risk-factor surveys
and NISR-style population estimates/projections. `python -m generator.external` writes data/external/*.parquet.

All three come from the same latent model as the EMR generator (config/generator.yaml hazards and insights, generator
population prevalences) with the assumptions in config/external.yaml. Every row carries source_note "(Synthetic)".
"""
