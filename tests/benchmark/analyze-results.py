#!/usr/bin/env python3
import os
import sys

def main():
    try:
        import pandas as pd
        import statsmodels.formula.api as smf
    except ImportError:
        print("Error: Missing python dependencies. Please install them:")
        print("  pip install pandas statsmodels")
        sys.exit(1)

    csv_path = os.path.join(os.path.dirname(__file__), "results.csv")
    if not os.path.exists(csv_path):
        print(f"Error: csv results file not found at: {csv_path}")
        print("Please run the benchmark first.")
        sys.exit(1)

    # Load data
    df = pd.read_csv(csv_path)
    if len(df) == 0:
        print("Error: The results CSV file is empty.")
        sys.exit(1)

    print("--- Linear Mixed-Effects Model (LMM) Analysis ---")
    print(f"Loaded {len(df)} observations from results.csv\n")

    # Fit LMM model: Score ~ Approach + Model + TaskCategory, Group = TaskInstance (random intercept)
    # This partitions task-level baseline difficulty from approach and model fixed effects.
    try:
        model = smf.mixedlm(
            "score ~ C(approach, Treatment(reference='vanilla')) + C(model) + C(taskCategory, Treatment(reference='neutral'))",
            df,
            groups=df["taskInstance"]
        )
        result = model.fit()
        print(result.summary())
    except Exception as e:
        print(f"LMM model fitting failed: {e}")
        print("\nAttempting simplified OLS regression as fallback:")
        try:
            ols_model = smf.ols(
                "score ~ C(approach, Treatment(reference='vanilla')) + C(model) + C(taskCategory, Treatment(reference='neutral'))",
                data=df
            )
            ols_result = ols_model.fit()
            print(ols_result.summary())
        except Exception as fallback_err:
            print(f"Fallback OLS regression also failed: {fallback_err}")
            sys.exit(1)

if __name__ == "__main__":
    main()
